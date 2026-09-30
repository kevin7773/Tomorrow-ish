import type { IncomingReviewNotification } from '../domain/review-notification-delivery';
import type { EditorialReminderStage, ReviewReminderKind } from '../domain/editorial-review-reminder';
import type { ReviewNotificationReceiverService } from '../services/review-notification-receiver-service';

const MAX_BODY_CHARACTERS = 16_384;
const EXPECTED_KEYS = ['batchId', 'reminderKind', 'reminderStage', 'reviewUrl', 'text'];
const STAGES = new Set<EditorialReminderStage>(['TRIAGE', 'FINAL_REVIEW']);
const KINDS = new Set<ReviewReminderKind>(['INITIAL', 'SIX_HOUR', 'FINAL']);

class InvalidReviewNotification extends Error {}

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

function requiredText(value: unknown, max: number): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value) {
		throw new InvalidReviewNotification();
	}
	return value;
}

function parseReviewUrl(value: unknown, requestUrl: URL, batchId: string, stage: EditorialReminderStage): string | null {
	if (value === null) return null;
	const text = requiredText(value, 2_000);
	let parsed: URL;
	try { parsed = new URL(text); } catch { throw new InvalidReviewNotification(); }
	const suffix = stage === 'TRIAGE' ? 'triage' : 'review';
	const expectedPath = `/editorial/batches/${encodeURIComponent(batchId)}/${suffix}`;
	if (parsed.protocol !== 'https:' || parsed.origin !== requestUrl.origin
		|| parsed.pathname !== expectedPath || parsed.search || parsed.hash) {
		throw new InvalidReviewNotification();
	}
	return parsed.toString();
}

function parsePayload(value: unknown, idempotencyKey: string, requestUrl: URL): IncomingReviewNotification {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidReviewNotification();
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join('\n') !== [...EXPECTED_KEYS].sort().join('\n')) throw new InvalidReviewNotification();
	const batchId = requiredText(record.batchId, 100);
	if (!/^[A-Za-z0-9-]+$/.test(batchId)) throw new InvalidReviewNotification();
	const stage = requiredText(record.reminderStage, 20) as EditorialReminderStage;
	const kind = requiredText(record.reminderKind, 20) as ReviewReminderKind;
	if (!STAGES.has(stage) || !KINDS.has(kind)) throw new InvalidReviewNotification();
	if (idempotencyKey !== `editorial-review:${batchId}:${stage}:${kind}`) throw new InvalidReviewNotification();
	return {
		idempotencyKey,
		batchId,
		stage,
		kind,
		message: requiredText(record.text, 1_000),
		reviewUrl: parseReviewUrl(record.reviewUrl, requestUrl, batchId, stage),
	};
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
		const notification = parsePayload(JSON.parse(raw), idempotencyKey, requestUrl);
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
