import type { ReviewNotificationReceiverService } from '../services/review-notification-receiver-service';
import { InvalidReviewNotification, validateReviewNotification } from './review-notification-validation';

const MAX_BODY_CHARACTERS = 16_384;

function response(status: number, state: string): Response {
	return Response.json({ state }, {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
			'X-Robots-Tag': 'noindex, nofollow',
		},
	});
}

export async function handleReviewNotificationRequest(
	request: Request,
	service: ReviewNotificationReceiverService,
): Promise<Response> {
	if (request.method !== 'POST') return response(405, 'method-not-allowed');
	const requestUrl = new URL(request.url);
	if (requestUrl.search) return response(400, 'malformed');
	const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (contentType !== 'application/json') return response(415, 'unsupported-media-type');
	const declaredLength = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_CHARACTERS) return response(413, 'too-large');
	const idempotencyKey = request.headers.get('idempotency-key') ?? '';
	if (idempotencyKey.length === 0 || idempotencyKey.length > 250) return response(400, 'malformed');
	try {
		const raw = await request.text();
		if (raw.length === 0 || raw.length > MAX_BODY_CHARACTERS) return response(413, 'too-large');
		const notification = validateReviewNotification(JSON.parse(raw), idempotencyKey, requestUrl.origin);
		const result = await service.receive(notification);
		switch (result) {
			case 'accepted': return response(200, 'accepted');
			case 'duplicate': return response(200, 'duplicate');
			case 'processing': return response(425, 'processing');
			case 'unauthorized': return response(403, 'rejected');
			case 'conflict': return response(409, 'conflict');
			case 'delivery-failed': return response(503, 'delivery-failed');
		}
	} catch (error) {
		if (error instanceof InvalidReviewNotification || error instanceof SyntaxError) return response(400, 'malformed');
		console.error('[review-notification-receiver] request failed', {
			exceptionName: error instanceof Error ? error.name : 'UnknownError',
		});
		return response(500, 'failed');
	}
}
