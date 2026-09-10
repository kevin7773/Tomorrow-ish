import type { APIRoute } from 'astro';
import { getEditorialRepository } from '../../../data/runtime-editorial-repository';
import {
	actionErrorResponse,
	formRecord,
	redirectWithResult,
	requireEditor,
	safeReturnPath,
} from '../../../lib/editorial-actions';
import { EditorialService } from '../../../services/editorial-service';

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/candidates');
	const service = new EditorialService(getEditorialRepository());

	try {
		const input = formRecord(form);
		switch (form.get('action')) {
			case 'create': {
				const id = await service.createCandidate(requireEditor(context), input);
				return redirectWithResult(`/editorial/candidates/${id}`, 'message', 'candidate-created');
			}
			case 'update':
				await service.updateCandidate(requireEditor(context), input);
				return redirectWithResult(returnPath, 'message', 'candidate-updated');
			case 'transition':
				await service.transitionCandidate(requireEditor(context), input);
				return redirectWithResult(returnPath, 'message', 'candidate-transitioned');
			default:
				return redirectWithResult(returnPath, 'error', 'invalid-request');
		}
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
