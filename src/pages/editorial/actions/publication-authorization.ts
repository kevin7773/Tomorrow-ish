import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { D1AutomatedPublicationAuthorizationRepository } from '../../../data/d1-automated-publication-authorization-repository';
import { actionErrorResponse, redirectWithResult, requireEditor, safeReturnPath } from '../../../lib/editorial-actions';
import { AutomatedPublicationAuthorizationService } from '../../../services/automated-publication-authorization-service';

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/batches');
	try {
		if (form.get('action') !== 'authorize') return redirectWithResult(returnPath, 'error', 'invalid-request');
		await new AutomatedPublicationAuthorizationService(
			new D1AutomatedPublicationAuthorizationRepository(env.DB),
		).authorize(requireEditor(context), {
			storyId: form.get('storyId'), imageId: form.get('imageId'),
			batchId: form.get('batchId'), intakeId: form.get('intakeId'),
			confirmation: form.get('confirmation'),
		});
		return redirectWithResult(returnPath, 'message', 'publication-authorized');
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
