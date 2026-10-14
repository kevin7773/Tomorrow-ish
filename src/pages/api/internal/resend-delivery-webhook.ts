import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { D1NotificationAcceptanceTestRepository } from '../../../data/notification-acceptance-test-repository';
import { D1ResendEmailRepository } from '../../../data/resend-email-repository';
import { handleResendWebhookRequest } from '../../../notifications/resend-email-endpoint';
import { ResendEmailProvider } from '../../../notifications/resend-email';
import { ResendEditorialEmailService } from '../../../services/resend-editorial-email-service';

export const POST: APIRoute = async ({ request }) => {
	const configuration = {
		apiKey: env.RESEND_API_KEY ?? '',
		webhookSigningSecret: env.RESEND_WEBHOOK_SIGNING_SECRET ?? '',
		toEmail: env.EDITORIAL_NOTIFICATION_TO_EMAIL ?? '',
		fromEmail: env.EDITORIAL_NOTIFICATION_FROM_EMAIL ?? '',
	};
	const repository = new D1ResendEmailRepository(env.DB);
	const acceptanceTests = new D1NotificationAcceptanceTestRepository(env.DB);
	const routineService = new ResendEditorialEmailService(
		repository, new ResendEmailProvider(configuration), configuration,
	);
	return handleResendWebhookRequest(
		request,
		{
			async receiveProviderEvent(event) {
				const routine = await routineService.receiveProviderEvent(event);
				if (routine !== 'UNKNOWN') return routine;
				return acceptanceTests.recordProviderEvent({
					eventId: event.eventId, providerEmailId: event.providerEmailId,
					idempotencyHash: event.idempotencyHash, eventType: event.type,
					providerCreatedAt: event.providerCreatedAt, payloadHash: event.payloadHash,
					receivedAt: new Date().toISOString(),
				});
			},
		},
		configuration,
	);
};
