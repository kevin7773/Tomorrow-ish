import type { ReviewNotification } from '../notifications/review-notifier';

export type ExternalDeliveryState = 'PENDING' | 'DELIVERED' | 'FAILED' | 'AMBIGUOUS';
export type ExternalDeliveryReservation = 'ACQUIRED' | 'DELIVERED' | 'BLOCKED' | 'CONFLICT';

export interface ExternalReviewNotificationRepository {
	reserve(notification: ReviewNotification, operationKey: string, owner: string, at: string): Promise<ExternalDeliveryReservation>;
	markDelivered(operationKey: string, owner: string, at: string, responseStatus: number, requestId: string | null): Promise<boolean>;
	markFailed(operationKey: string, owner: string, at: string, classification: string, responseStatus: number | null, requestId: string | null): Promise<boolean>;
	markAmbiguous(operationKey: string, owner: string, at: string, classification: string, responseStatus: number | null, requestId: string | null): Promise<boolean>;
}

export class D1ExternalReviewNotificationRepository implements ExternalReviewNotificationRepository {
	constructor(private readonly db: D1Database) {}

	async reserve(notification: ReviewNotification, operationKey: string, owner: string, at: string): Promise<ExternalDeliveryReservation> {
		const inserted = await this.db.prepare(`INSERT OR IGNORE INTO external_review_notification_deliveries (
			operation_key, idempotency_key, batch_id, stage, kind, message_text, review_url,
			status, owner_token, attempt_count, created_at, updated_at
		) SELECT ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 1, ?, ? WHERE EXISTS (
			SELECT 1 FROM editorial_stage_reminders WHERE batch_id = ? AND stage = ?
			AND claim_kind = ? AND claim_token IS NOT NULL AND resolved_at IS NULL
		)`).bind(operationKey, notification.idempotencyKey, notification.batchId, notification.stage,
			notification.kind, notification.message, notification.reviewUrl, owner, at, at,
			notification.batchId, notification.stage, notification.kind).run();
		if (inserted.meta.changes === 1) return 'ACQUIRED';
		const existing = await this.db.prepare(`SELECT idempotency_key, batch_id, stage, kind,
			message_text, review_url, status FROM external_review_notification_deliveries
			WHERE operation_key = ?`).bind(operationKey).first<{
			idempotency_key: string; batch_id: string; stage: string; kind: string;
			message_text: string; review_url: string | null; status: ExternalDeliveryState;
		}>();
		if (!existing) return 'BLOCKED';
		if (existing.idempotency_key !== notification.idempotencyKey || existing.batch_id !== notification.batchId
			|| existing.stage !== notification.stage || existing.kind !== notification.kind
			|| existing.message_text !== notification.message || existing.review_url !== notification.reviewUrl) return 'CONFLICT';
		return existing.status === 'DELIVERED' ? 'DELIVERED' : 'BLOCKED';
	}

	private async finish(operationKey: string, owner: string, at: string, status: ExternalDeliveryState,
		classification: string | null, responseStatus: number | null, requestId: string | null): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE external_review_notification_deliveries
			SET status = ?, failure_classification = ?, response_status = ?, provider_request_id = ?,
				updated_at = ?, delivered_at = CASE WHEN ? = 'DELIVERED' THEN ? ELSE NULL END
			WHERE operation_key = ? AND owner_token = ? AND status = 'PENDING'`)
			.bind(status, classification, responseStatus, requestId, at, status, at, operationKey, owner).run();
		return result.meta.changes === 1;
	}

	markDelivered(operationKey: string, owner: string, at: string, responseStatus: number, requestId: string | null) {
		return this.finish(operationKey, owner, at, 'DELIVERED', null, responseStatus, requestId);
	}
	markFailed(operationKey: string, owner: string, at: string, classification: string, responseStatus: number | null, requestId: string | null) {
		return this.finish(operationKey, owner, at, 'FAILED', classification, responseStatus, requestId);
	}
	markAmbiguous(operationKey: string, owner: string, at: string, classification: string, responseStatus: number | null, requestId: string | null) {
		return this.finish(operationKey, owner, at, 'AMBIGUOUS', classification, responseStatus, requestId);
	}
}
