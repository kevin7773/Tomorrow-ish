import type { IncomingReviewNotification } from '../domain/review-notification-delivery';
import type { EditorialReminderStage, ReviewReminderKind } from '../domain/editorial-review-reminder';

const EXPECTED_KEYS = ['batchId', 'reminderKind', 'reminderStage', 'reviewUrl', 'text'];
const STAGES = new Set<EditorialReminderStage>(['TRIAGE', 'FINAL_REVIEW']);
const KINDS = new Set<ReviewReminderKind>(['INITIAL', 'SIX_HOUR', 'FINAL']);

export class InvalidReviewNotification extends Error {}

function requiredText(value: unknown, max: number): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value) {
		throw new InvalidReviewNotification();
	}
	return value;
}

function parseReviewUrl(
	value: unknown,
	expectedOrigin: string,
	batchId: string,
	stage: EditorialReminderStage,
): string | null {
	if (value === null) return null;
	const text = requiredText(value, 2_000);
	let parsed: URL;
	try { parsed = new URL(text); } catch { throw new InvalidReviewNotification(); }
	const suffix = stage === 'TRIAGE' ? 'triage' : 'review';
	const expectedPath = `/editorial/batches/${encodeURIComponent(batchId)}/${suffix}`;
	if (parsed.protocol !== 'https:' || parsed.origin !== expectedOrigin
		|| parsed.pathname !== expectedPath || parsed.search || parsed.hash) {
		throw new InvalidReviewNotification();
	}
	return parsed.toString();
}

export function validateReviewNotification(
	payload: unknown,
	idempotencyKey: string,
	expectedOrigin: string,
): IncomingReviewNotification {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new InvalidReviewNotification();
	const record = payload as Record<string, unknown>;
	if (Object.keys(record).sort().join('\n') !== [...EXPECTED_KEYS].sort().join('\n')) {
		throw new InvalidReviewNotification();
	}
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
		reviewUrl: parseReviewUrl(record.reviewUrl, expectedOrigin, batchId, stage),
	};
}
