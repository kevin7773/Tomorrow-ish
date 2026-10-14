import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { D1NotificationAcceptanceTestRepository } from '../../../data/notification-acceptance-test-repository';
import { actionErrorResponse, redirectWithResult, requireEditor, safeReturnPath } from '../../../lib/editorial-actions';
import { ResendEmailProvider } from '../../../notifications/resend-email';
import { NotificationAcceptanceTestService } from '../../../services/notification-acceptance-test-service';

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/notifications');
	try {
		const identity = requireEditor(context);
		if (form.get('action') !== 'send-acceptance-test') {
			return redirectWithResult(returnPath, 'error', 'invalid-request');
		}
		const configuration = {
			apiKey: env.RESEND_API_KEY ?? '',
			webhookSigningSecret: env.RESEND_WEBHOOK_SIGNING_SECRET ?? '',
			toEmail: env.EDITORIAL_NOTIFICATION_TO_EMAIL ?? '',
			fromEmail: env.EDITORIAL_NOTIFICATION_FROM_EMAIL ?? '',
		};
		const result = await new NotificationAcceptanceTestService(
			new D1NotificationAcceptanceTestRepository(env.DB),
			() => new ResendEmailProvider(configuration),
			configuration,
			{
				EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED:
					env.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED,
				EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID:
					env.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID,
			},
		).submit(identity, {
			authorizationId: form.get('authorizationId'),
			confirmation: form.get('confirmation'),
		});
		const extra = { testId: result.testId };
		if (result.deliveryState === 'PENDING') {
			return redirectWithResult(returnPath, 'message', 'notification-test-pending', extra);
		}
		if (result.deliveryState === 'DELIVERED') {
			return redirectWithResult(returnPath, 'message', 'notification-test-delivered', extra);
		}
		return redirectWithResult(returnPath, 'error',
			result.deliveryState === 'AMBIGUOUS' ? 'notification-test-ambiguous' : 'notification-test-failed', extra);
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
