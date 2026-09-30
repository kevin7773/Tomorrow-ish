import type { APIRoute } from 'astro';
import { getEditorialRepository } from '../../../data/runtime-editorial-repository';
import { actionErrorResponse, formRecord, redirectWithResult, requireEditor, safeReturnPath } from '../../../lib/editorial-actions';
import { EditorialService } from '../../../services/editorial-service';
import { getEditorialWorkflowService } from '../../../services/runtime-editorial-workflow';

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/batches');
	const workflow = getEditorialWorkflowService();
	const identity = requireEditor(context);
	try {
		switch (form.get('action')) {
			case 'retry': await workflow.retry(identity, form.get('batchId'), form.get('intakeId')); break;
			case 'publish': await workflow.publish(identity, form.get('batchId'), form.get('intakeId'), form.get('confirmation')); break;
			case 'reject': await workflow.reject(identity, form.get('batchId'), form.get('intakeId'), form.get('confirmation')); break;
			case 'regenerate-image': await workflow.regenerateImage(identity, form.get('batchId'), form.get('intakeId')); break;
			case 'edit':
				await new EditorialService(getEditorialRepository()).updateStory(identity, formRecord(form));
				await workflow.recordEdit(identity, String(form.get('batchId')), String(form.get('intakeId')), String(form.get('id')));
				break;
			default: return redirectWithResult(returnPath, 'error', 'invalid-request');
		}
		return redirectWithResult(returnPath, 'message', 'workflow-updated');
	} catch (error) { return actionErrorResponse(error, returnPath); }
};
