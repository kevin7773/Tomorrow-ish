import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getEditorialWorkflowRepository } from '../../../data/runtime-editorial-workflow-repository';
import { actionErrorResponse, formRecord, redirectWithResult, requireEditor, safeReturnPath } from '../../../lib/editorial-actions';
import { CandidateSelectionService } from '../../../services/candidate-selection-service';
import { smokeTarget } from '../../../services/editorial-smoke-target';

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/candidates');
	try {
		const service = new CandidateSelectionService(
			getEditorialWorkflowRepository(),
			smokeTarget(env.EDITORIAL_WORKFLOW_SMOKE_BATCH_ID, env.EDITORIAL_WORKFLOW_SMOKE_INTAKE_ID),
		);
		const result = await service.select(requireEditor(context), formRecord(form));
		return redirectWithResult(returnPath, 'message', result === 'UNCHANGED' ? 'candidate-selection-unchanged' : 'candidate-selected');
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
