import type { APIRoute } from 'astro';
import { getRuntimeModelConfiguration } from '../../../ai/runtime-model-provider';
import { getGenerationRepository } from '../../../data/runtime-generation-repository';
import {
	actionErrorResponse,
	formRecord,
	redirectWithResult,
	requireEditor,
	safeReturnPath,
} from '../../../lib/editorial-actions';
import { GenerationService } from '../../../services/generation-service';
import type { ModelProvider } from '../../../ai/model-provider';

const unusedProvider: ModelProvider = {
	providerId: 'unused', modelId: 'unused', estimateMaximumCostMicrousd: () => 0,
	normalizeEvent: async () => { throw new Error('unreachable'); },
	generateCandidates: async () => { throw new Error('unreachable'); },
	generateArticleBody: async () => { throw new Error('unreachable'); },
};

function proposalFromForm(form: FormData): unknown {
	return {
		eventStatement: form.get('eventStatement'),
		assertions: JSON.parse(String(form.get('assertionsJson') ?? '[]')),
		proposedSignificanceScore: Number(form.get('proposedSignificanceScore')),
		proposedSatirePotentialScore: Number(form.get('proposedSatirePotentialScore')),
		proposedSuitability: form.get('proposedSuitability'),
		suitabilityReason: form.get('suitabilityReason'),
		guardrailFlags: form.getAll('guardrailFlags'),
	};
}

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/intakes');
	try {
		const identity = requireEditor(context);
		const action = form.get('action');
		if (action === 'resolve-body-pending') {
			const candidateId = String(form.get('candidateId') ?? '');
			const service = new GenerationService(getGenerationRepository(), unusedProvider, { generationEnabled: false });
			await service.resolveStaleArticleBodyGeneration(identity, formRecord(form));
			return redirectWithResult(`/editorial/candidates/${encodeURIComponent(candidateId)}`, 'message', 'article-body-pending-resolved');
		}
		const model = getRuntimeModelConfiguration();
		const service = new GenerationService(getGenerationRepository(), model.provider, {
			dailyBudgetMicrousd: model.dailyBudgetMicrousd,
			generationEnabled: model.generationEnabled,
		});
		switch (action) {
			case 'normalize': {
				const id = await service.proposeNormalization(identity, form.get('intakeId'), form.get('idempotencyKey'));
				return redirectWithResult(`/editorial/intakes/${form.get('intakeId')}/normalize?version=${encodeURIComponent(id)}`, 'message', 'normalization-proposed');
			}
			case 'revise': {
				const id = await service.createEditorRevision(identity, form.get('parentVersionId'), proposalFromForm(form), form.get('revisionReason'));
				return redirectWithResult(`${returnPath}?version=${encodeURIComponent(id)}`, 'message', 'normalization-revised');
			}
			case 'review':
				await service.reviewNormalization(identity, form.get('versionId'), form.get('decision'), form.get('reason'));
				return redirectWithResult(returnPath, 'message', form.get('decision') === 'ACCEPTED' ? 'normalization-accepted' : 'normalization-rejected');
			case 'supersede':
				await service.supersedeNormalization(identity, form.get('versionId'), form.get('reason'));
				return redirectWithResult(returnPath, 'message', 'normalization-superseded');
			case 'generate': {
				const runId = await service.generateCandidates(identity, formRecord(form));
				return redirectWithResult(`/editorial/model-runs/${runId}`, 'message', 'candidates-generated');
			}
			case 'generate-body': {
				const candidateId = String(form.get('candidateId') ?? '');
				await service.generateArticleBody(identity, formRecord(form));
				return redirectWithResult(`/editorial/candidates/${encodeURIComponent(candidateId)}`, 'message', 'article-body-generated');
			}
			default:
				return redirectWithResult(returnPath, 'error', 'invalid-request');
		}
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
