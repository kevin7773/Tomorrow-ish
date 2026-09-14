import type { APIRoute } from 'astro';
import { getEditorialRepository } from '../../../data/runtime-editorial-repository';
import { handleEditorialArchiveAction } from '../../../lib/editorial-archive-action';
import { actionErrorResponse, requireEditor, safeReturnPath } from '../../../lib/editorial-actions';
import { EditorialService } from '../../../services/editorial-service';

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/history');
	const service = new EditorialService(getEditorialRepository());

	try {
		const identity = requireEditor(context);
		return await handleEditorialArchiveAction(form, identity, service);
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
