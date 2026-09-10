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
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/intakes');
	const service = new EditorialService(getEditorialRepository());

	try {
		const input = formRecord(form);
		switch (form.get('action')) {
			case 'create': {
				const id = await service.createIntake(requireEditor(context), input);
				return redirectWithResult(`/editorial/intakes/${id}`, 'message', 'intake-created');
			}
			case 'update':
				await service.updateIntake(requireEditor(context), input);
				return redirectWithResult(returnPath, 'message', 'intake-updated');
			case 'add-reference':
				await service.addSourceReference(requireEditor(context), input);
				return redirectWithResult(returnPath, 'message', 'reference-added');
			case 'update-reference':
				await service.updateSourceReference(requireEditor(context), input);
				return redirectWithResult(returnPath, 'message', 'reference-updated');
			default:
				return redirectWithResult(returnPath, 'error', 'invalid-request');
		}
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
