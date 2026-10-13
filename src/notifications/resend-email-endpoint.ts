import type { ReviewNotification } from './review-notifier';
import { InvalidReviewNotification, validateReviewNotification } from './review-notification-validation';
import {
	readVerifiedResendWebhook,
	ResendWebhookError,
	type ResendEmailConfiguration,
} from './resend-email';
import type { ResendEditorialEmailService } from '../services/resend-editorial-email-service';

const MAX_BODY_CHARACTERS = 16_384;

function response(status: number, body: unknown): Response {
	return Response.json(body, { status, headers: {
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'X-Robots-Tag': 'noindex, nofollow',
	} });
}

function equalConstantTime(left: string, right: string): boolean {
	const length = Math.max(left.length, right.length);
	let difference = left.length ^ right.length;
	for (let index = 0; index < length; index += 1) {
		difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return difference === 0;
}

function authenticated(request: Request, bearerToken: string): boolean {
	const expected = bearerToken.trim();
	if (new TextEncoder().encode(expected).byteLength < 32) return false;
	return equalConstantTime(request.headers.get('authorization') ?? '', `Bearer ${expected}`);
}

export async function handleResendEmailSubmissionRequest(
	request: Request,
	service: Pick<ResendEditorialEmailService, 'submit'>,
	bearerToken: string,
): Promise<Response> {
	if (request.method !== 'POST') return response(405, { state: 'method-not-allowed' });
	if (new URL(request.url).protocol !== 'https:') return response(400, { state: 'https-required' });
	if (!authenticated(request, bearerToken)) return response(401, { state: 'unauthorized' });
	if (new URL(request.url).search) return response(400, { state: 'malformed' });
	if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
		return response(415, { state: 'unsupported-media-type' });
	}
	const idempotencyKey = request.headers.get('idempotency-key') ?? '';
	try {
		const raw = await request.text();
		if (!raw || raw.length > MAX_BODY_CHARACTERS) return response(413, { state: 'too-large' });
		const notification: ReviewNotification = validateReviewNotification(
			JSON.parse(raw), idempotencyKey, new URL(request.url).origin,
		);
		const acknowledgement = await service.submit(notification);
		if (acknowledgement.deliveryState === 'DELIVERED') return response(200, acknowledgement);
		if (acknowledgement.deliveryState === 'FAILED') return response(422, acknowledgement);
		return response(202, acknowledgement);
	} catch (error) {
		if (error instanceof InvalidReviewNotification || error instanceof SyntaxError) {
			return response(400, { state: 'malformed' });
		}
		console.error('[resend-email] submission endpoint failed', {
			exceptionName: error instanceof Error ? error.name : 'UnknownError',
		});
		return response(500, { state: 'failed' });
	}
}

export async function handleResendWebhookRequest(
	request: Request,
	service: Pick<ResendEditorialEmailService, 'receiveProviderEvent'>,
	configuration: Pick<ResendEmailConfiguration, 'webhookSigningSecret' | 'toEmail'>,
	now: () => Date = () => new Date(),
): Promise<Response> {
	try {
		if (new URL(request.url).protocol !== 'https:') return response(400, { state: 'https-required' });
		const event = await readVerifiedResendWebhook(request, configuration, now);
		const result = await service.receiveProviderEvent(event);
		if (result === 'UNKNOWN') return response(404, { state: 'unknown-provider-email' });
		return response(200, { state: result === 'DUPLICATE' ? 'duplicate' : 'accepted', eventId: event.eventId });
	} catch (error) {
		if (error instanceof ResendWebhookError) return response(error.status, { state: 'rejected' });
		console.error('[resend-email] webhook processing failed', {
			exceptionName: error instanceof Error ? error.name : 'UnknownError',
		});
		return response(500, { state: 'failed' });
	}
}
