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
	try {
		const storyId = await new EditorialService(
			getEditorialRepository(),
		).convertApprovedCandidateToDraft(requireEditor(context), formRecord(form));
		return redirectWithResult(`/editorial/stories/${storyId}`, 'message', 'candidate-converted');
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
