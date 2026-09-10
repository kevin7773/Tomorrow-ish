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
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/stories');
	const service = new EditorialService(getEditorialRepository());

	try {
		const input = formRecord(form);
		switch (form.get('action')) {
			case 'update':
				await service.updateStory(requireEditor(context), input);
				return redirectWithResult(returnPath, 'message', 'story-updated');
			case 'transition':
				await service.transitionStory(requireEditor(context), input);
				return redirectWithResult(returnPath, 'message', 'story-transitioned');
			default:
				return redirectWithResult(returnPath, 'error', 'invalid-request');
		}
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
