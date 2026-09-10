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
		const model = getRuntimeModelConfiguration();
		const service = new GenerationService(getGenerationRepository(), model.provider, {
			dailyBudgetMicrousd: model.dailyBudgetMicrousd,
		});
		switch (form.get('action')) {
			case 'normalize': {
				const id = await service.proposeNormalization(requireEditor(context), form.get('intakeId'), form.get('idempotencyKey'));
				return redirectWithResult(`/editorial/intakes/${form.get('intakeId')}/normalize?version=${encodeURIComponent(id)}`, 'message', 'normalization-proposed');
			}
			case 'revise': {
				const id = await service.createEditorRevision(requireEditor(context), form.get('parentVersionId'), proposalFromForm(form), form.get('revisionReason'));
				return redirectWithResult(`${returnPath}?version=${encodeURIComponent(id)}`, 'message', 'normalization-revised');
			}
			case 'review':
				await service.reviewNormalization(requireEditor(context), form.get('versionId'), form.get('decision'), form.get('reason'));
				return redirectWithResult(returnPath, 'message', form.get('decision') === 'ACCEPTED' ? 'normalization-accepted' : 'normalization-rejected');
			case 'supersede':
				await service.supersedeNormalization(requireEditor(context), form.get('versionId'), form.get('reason'));
				return redirectWithResult(returnPath, 'message', 'normalization-superseded');
			case 'generate': {
				const runId = await service.generateCandidates(requireEditor(context), formRecord(form));
				return redirectWithResult(`/editorial/model-runs/${runId}`, 'message', 'candidates-generated');
			}
			default:
				return redirectWithResult(returnPath, 'error', 'invalid-request');
		}
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
