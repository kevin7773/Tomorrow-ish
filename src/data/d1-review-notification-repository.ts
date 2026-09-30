import type {
	BeginReviewNotificationResult,
	EditorialNotificationDeliveryPort,
	ReviewNotificationReceiptRepository,
} from './review-notification-repository';
import type {
	EditorialNotification,
	IncomingReviewNotification,
	ReviewNotificationReceipt,
	ReviewNotificationReceiptState,
} from '../domain/review-notification-delivery';
import type { EditorialReminderStage, ReviewReminderKind } from '../domain/editorial-review-reminder';

interface ReceiptRow {
	idempotency_key: string; batch_id: string; stage: EditorialReminderStage; kind: ReviewReminderKind;
	message_text: string; review_url: string | null; status: ReviewNotificationReceiptState;
	attempt_count: number; failure_classification: string | null; received_at: string;
	last_attempt_at: string; delivered_at: string | null;
}

interface NotificationRow {
	idempotency_key: string; batch_id: string; stage: EditorialReminderStage; kind: ReviewReminderKind;
	message_text: string; review_url: string | null; created_at: string;
}

function receipt(row: ReceiptRow): ReviewNotificationReceipt {
	return {
		idempotencyKey: row.idempotency_key, batchId: row.batch_id, stage: row.stage, kind: row.kind,
		message: row.message_text, reviewUrl: row.review_url, status: row.status,
		attemptCount: row.attempt_count, failureClassification: row.failure_classification,
		receivedAt: row.received_at, lastAttemptAt: row.last_attempt_at, deliveredAt: row.delivered_at,
	};
}

function samePayload(existing: ReviewNotificationReceipt, incoming: IncomingReviewNotification): boolean {
	return existing.batchId === incoming.batchId && existing.stage === incoming.stage
		&& existing.kind === incoming.kind && existing.message === incoming.message
		&& existing.reviewUrl === incoming.reviewUrl;
}

export class D1ReviewNotificationRepository implements ReviewNotificationReceiptRepository {
	constructor(private readonly db: D1Database) {}

	async find(idempotencyKey: string): Promise<ReviewNotificationReceipt | null> {
		const row = await this.db.prepare('SELECT * FROM review_notification_receipts WHERE idempotency_key = ?')
			.bind(idempotencyKey).first<ReceiptRow>();
		return row ? receipt(row) : null;
	}

	async begin(notification: IncomingReviewNotification, receivedAt: string): Promise<BeginReviewNotificationResult> {
		const existing = await this.find(notification.idempotencyKey);
		if (existing) {
			if (!samePayload(existing, notification)) return 'conflict';
			if (existing.status === 'DELIVERED') return 'duplicate';
			if (existing.status === 'PROCESSING') return 'processing';
			const retried = await this.db.prepare(`UPDATE review_notification_receipts
				SET status = 'PROCESSING', attempt_count = attempt_count + 1,
					failure_classification = NULL, last_attempt_at = ?
				WHERE idempotency_key = ? AND status = 'FAILED' AND EXISTS (
					SELECT 1 FROM editorial_stage_reminders AS reminder
					WHERE reminder.batch_id = review_notification_receipts.batch_id
					AND reminder.stage = review_notification_receipts.stage
					AND reminder.claim_kind = review_notification_receipts.kind
					AND reminder.claim_token IS NOT NULL AND reminder.resolved_at IS NULL
				)`).bind(receivedAt, notification.idempotencyKey).run();
			return retried.meta.changes === 1 ? 'accepted' : 'unauthorized';
		}

		const inserted = await this.db.prepare(`INSERT OR IGNORE INTO review_notification_receipts (
			idempotency_key, batch_id, stage, kind, message_text, review_url, status,
			attempt_count, received_at, last_attempt_at
		) SELECT ?, ?, ?, ?, ?, ?, 'PROCESSING', 1, ?, ? WHERE EXISTS (
			SELECT 1 FROM editorial_stage_reminders AS reminder
			WHERE reminder.batch_id = ? AND reminder.stage = ? AND reminder.claim_kind = ?
			AND reminder.claim_token IS NOT NULL AND reminder.resolved_at IS NULL
		)`).bind(
			notification.idempotencyKey, notification.batchId, notification.stage, notification.kind,
			notification.message, notification.reviewUrl, receivedAt, receivedAt,
			notification.batchId, notification.stage, notification.kind,
		).run();
		if (inserted.meta.changes === 1) return 'accepted';
		const raced = await this.find(notification.idempotencyKey);
		if (!raced) return 'unauthorized';
		if (!samePayload(raced, notification)) return 'conflict';
		return raced.status === 'DELIVERED' ? 'duplicate' : 'processing';
	}

	async markDelivered(idempotencyKey: string, deliveredAt: string): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE review_notification_receipts
			SET status = 'DELIVERED', delivered_at = ?, failure_classification = NULL
			WHERE idempotency_key = ? AND status = 'PROCESSING'
			AND EXISTS (SELECT 1 FROM editorial_notifications WHERE idempotency_key = ?)`)
			.bind(deliveredAt, idempotencyKey, idempotencyKey).run();
		return result.meta.changes === 1;
	}

	async markFailed(idempotencyKey: string, failedAt: string, classification: string): Promise<void> {
		await this.db.prepare(`UPDATE review_notification_receipts SET status = 'FAILED',
			failure_classification = ?, last_attempt_at = ?
			WHERE idempotency_key = ? AND status = 'PROCESSING'`)
			.bind(classification, failedAt, idempotencyKey).run();
	}

	async listDelivered(limit = 50): Promise<EditorialNotification[]> {
		const rows = await this.db.prepare(`SELECT idempotency_key, batch_id, stage, kind,
			message_text, review_url, created_at FROM editorial_notifications
			ORDER BY created_at DESC, idempotency_key DESC LIMIT ?`).bind(limit).all<NotificationRow>();
		return rows.results.map((row) => ({
			idempotencyKey: row.idempotency_key, batchId: row.batch_id, stage: row.stage,
			kind: row.kind, message: row.message_text, reviewUrl: row.review_url, createdAt: row.created_at,
		}));
	}
}

export class D1EditorialNotificationDelivery implements EditorialNotificationDeliveryPort {
	constructor(private readonly db: D1Database) {}

	async deliver(notification: IncomingReviewNotification, deliveredAt: string): Promise<void> {
		const result = await this.db.prepare(`INSERT OR IGNORE INTO editorial_notifications (
			idempotency_key, batch_id, stage, kind, message_text, review_url, created_at
		) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
			SELECT 1 FROM review_notification_receipts
			WHERE idempotency_key = ? AND status = 'PROCESSING'
		)`).bind(
			notification.idempotencyKey, notification.batchId, notification.stage, notification.kind,
			notification.message, notification.reviewUrl, deliveredAt, notification.idempotencyKey,
		).run();
		if (result.meta.changes === 1) return;
		const existing = await this.db.prepare(`SELECT 1 FROM editorial_notifications
			WHERE idempotency_key = ? AND batch_id = ? AND stage = ? AND kind = ?
			AND message_text = ? AND review_url IS ?`).bind(
			notification.idempotencyKey, notification.batchId, notification.stage,
			notification.kind, notification.message, notification.reviewUrl,
		).first();
		if (!existing) throw new Error('EDITORIAL_NOTIFICATION_DELIVERY_FAILED');
	}
}
