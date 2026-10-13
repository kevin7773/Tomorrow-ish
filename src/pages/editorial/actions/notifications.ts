import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { D1ExternalReviewNotificationRepository } from '../../../data/external-review-notification-repository';
import { actionErrorResponse, formRecord, redirectWithResult, requireEditor, safeReturnPath } from '../../../lib/editorial-actions';
import { ExternalNotificationReconciliationService } from '../../../services/external-notification-reconciliation-service';

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/notifications');
	try {
		if (form.get('action') !== 'reconcile-external') return redirectWithResult(returnPath, 'error', 'invalid-request');
		const input = formRecord(form);
		await new ExternalNotificationReconciliationService(
			new D1ExternalReviewNotificationRepository(env.DB),
		).reconcile(requireEditor(context), {
			operationKey: input.operationKey,
			decision: input.decision,
			evidenceReference: input.evidenceReference,
			confirmation: input.confirmation,
		});
		return redirectWithResult(returnPath, 'message', 'notification-reconciled');
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
