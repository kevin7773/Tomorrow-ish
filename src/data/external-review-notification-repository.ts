import type { ReviewNotification } from '../notifications/review-notifier';

export type ExternalDeliveryState = 'PENDING' | 'DELIVERED' | 'FAILED' | 'AMBIGUOUS';
export type ExternalDeliveryReservation = 'ACQUIRED' | 'DELIVERED' | 'BLOCKED' | 'CONFLICT';
export type ExternalDeliveryReconciliationDecision = 'CONFIRMED_DELIVERED' | 'CONFIRMED_FAILED' | 'MANUALLY_DELIVERED';

export interface ExternalDeliveryRecord {
	operationKey: string;
	idempotencyKey: string;
	batchId: string;
	stage: string;
	kind: string;
	status: ExternalDeliveryState;
	responseStatus: number | null;
	providerRequestId: string | null;
	failureClassification: string | null;
	updatedAt: string;
}

export interface ExternalNotificationReconciliationRepository {
	find(operationKey: string): Promise<ExternalDeliveryRecord | null>;
	listForInvestigation(limit: number): Promise<ExternalDeliveryRecord[]>;
	reconcile(record: { id: string; operationKey: string; decision: ExternalDeliveryReconciliationDecision;
		evidenceReference: string; actorEmail: string; createdAt: string }): Promise<boolean>;
}

export interface ExternalReviewNotificationRepository {
	reserve(notification: ReviewNotification, operationKey: string, owner: string, at: string): Promise<ExternalDeliveryReservation>;
	markSubmitted(operationKey: string, owner: string, at: string, responseStatus: number, requestId: string): Promise<boolean>;
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
			|| existing.stage !== notification.stage || existing.kind !== notification.kind) return 'CONFLICT';
		// Once signed or governed evidence confirms this logical reminder, the scheduler may safely
		// complete its durable claim even if the live pending count changed while delivery was in flight.
		if (existing.status === 'DELIVERED') return 'DELIVERED';
		if (existing.message_text !== notification.message || existing.review_url !== notification.reviewUrl) return 'CONFLICT';
		return 'BLOCKED';
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
	async markSubmitted(operationKey: string, owner: string, at: string, responseStatus: number, requestId: string): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE external_review_notification_deliveries
			SET response_status = ?, provider_request_id = ?, failure_classification = NULL, updated_at = ?
			WHERE operation_key = ? AND owner_token = ? AND status = 'PENDING'
			AND (provider_request_id IS NULL OR provider_request_id = ?)`)
			.bind(responseStatus, requestId, at, operationKey, owner, requestId).run();
		return result.meta.changes === 1;
	}
	markFailed(operationKey: string, owner: string, at: string, classification: string, responseStatus: number | null, requestId: string | null) {
		return this.finish(operationKey, owner, at, 'FAILED', classification, responseStatus, requestId);
	}
	markAmbiguous(operationKey: string, owner: string, at: string, classification: string, responseStatus: number | null, requestId: string | null) {
		return this.finish(operationKey, owner, at, 'AMBIGUOUS', classification, responseStatus, requestId);
	}

	private static record(row: {
		operation_key: string; idempotency_key: string; batch_id: string; stage: string; kind: string;
		status: ExternalDeliveryState; response_status: number | null; provider_request_id: string | null;
		failure_classification: string | null; updated_at: string;
	}): ExternalDeliveryRecord {
		return { operationKey: row.operation_key, idempotencyKey: row.idempotency_key, batchId: row.batch_id,
			stage: row.stage, kind: row.kind, status: row.status, responseStatus: row.response_status,
			providerRequestId: row.provider_request_id, failureClassification: row.failure_classification,
			updatedAt: row.updated_at };
	}

	async find(operationKey: string): Promise<ExternalDeliveryRecord | null> {
		const row = await this.db.prepare(`SELECT operation_key, idempotency_key, batch_id, stage, kind, status,
			response_status, provider_request_id, failure_classification, updated_at
			FROM external_review_notification_deliveries WHERE operation_key = ?`).bind(operationKey).first<any>();
		return row ? D1ExternalReviewNotificationRepository.record(row) : null;
	}

	async listForInvestigation(limit: number): Promise<ExternalDeliveryRecord[]> {
		const rows = await this.db.prepare(`SELECT operation_key, idempotency_key, batch_id, stage, kind, status,
			response_status, provider_request_id, failure_classification, updated_at
			FROM external_review_notification_deliveries WHERE status <> 'DELIVERED'
			ORDER BY updated_at, operation_key LIMIT ?`).bind(Math.max(1, Math.min(limit, 100))).all<any>();
		return rows.results.map(D1ExternalReviewNotificationRepository.record);
	}

	async reconcile(record: { id: string; operationKey: string; decision: ExternalDeliveryReconciliationDecision;
		evidenceReference: string; actorEmail: string; createdAt: string }): Promise<boolean> {
		const result = await this.db.prepare(`INSERT INTO external_review_notification_reconciliations
			(id, operation_key, decision, evidence_reference, actor_email, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`).bind(record.id, record.operationKey, record.decision,
				record.evidenceReference, record.actorEmail, record.createdAt).run();
		return result.meta.changes === 1;
	}
}
