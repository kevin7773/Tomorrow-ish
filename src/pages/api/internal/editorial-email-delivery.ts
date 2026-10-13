import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { D1ResendEmailRepository } from '../../../data/resend-email-repository';
import { handleResendEmailSubmissionRequest } from '../../../notifications/resend-email-endpoint';
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
	return handleResendEmailSubmissionRequest(
		request,
		new ResendEditorialEmailService(repository, new ResendEmailProvider(configuration), configuration),
		env.REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN ?? '',
	);
};
