import type { APIRoute } from 'astro';
import { getEditorialWorkflowService } from '../../../services/runtime-editorial-workflow';
import { actionErrorResponse, redirectWithResult, requireEditor } from '../../../lib/editorial-actions';

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const batchId = String(form.get('batchId') ?? '');
	const returnPath = `/editorial/batches/${encodeURIComponent(batchId)}/triage`;
	try {
		const decision = form.get('decision');
		if (decision !== 'SELECT' && decision !== 'REJECT') return redirectWithResult(returnPath, 'error', 'invalid-request');
		await getEditorialWorkflowService().triage(requireEditor(context), batchId, form.getAll('intakeId'), decision);
		return redirectWithResult(returnPath, 'message', decision === 'SELECT' ? 'intakes-selected' : 'intakes-rejected');
	} catch (error) { return actionErrorResponse(error, returnPath); }
};
