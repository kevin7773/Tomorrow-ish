import type { ReviewNotification } from '../notifications/review-notifier';

export type ResendSubmissionState = 'PENDING' | 'DELIVERED' | 'FAILED' | 'AMBIGUOUS';
export type ResendReservationResult = 'ACQUIRED' | ResendSubmissionState | 'CONFLICT' | 'BLOCKED';
export type ResendProviderEventType =
	| 'email.delivered'
	| 'email.delivery_delayed'
	| 'email.failed'
	| 'email.bounced'
	| 'email.suppressed';

export interface ResendSubmissionRecord {
	idempotencyKey: string;
	operationKey: string;
	idempotencyHash: string;
	payloadHash: string;
	status: ResendSubmissionState;
	providerEmailId: string | null;
	failureClassification: string | null;
	responseStatus: number | null;
}

export interface ResendEmailRepository {
	reserve(notification: ReviewNotification, payloadHash: string, idempotencyHash: string, at: string): Promise<ResendReservationResult>;
	find(idempotencyKey: string): Promise<ResendSubmissionRecord | null>;
	countPending(batchId: string, stage: ReviewNotification['stage']): Promise<number>;
	markAccepted(idempotencyKey: string, providerEmailId: string, responseStatus: number, at: string): Promise<boolean>;
	markAmbiguous(idempotencyKey: string, classification: string, responseStatus: number | null, at: string): Promise<boolean>;
	markFailed(idempotencyKey: string, classification: string, responseStatus: number | null, at: string): Promise<boolean>;
	recordProviderEvent(record: {
		eventId: string;
		providerEmailId: string;
		idempotencyHash: string;
		eventType: ResendProviderEventType;
		providerCreatedAt: string;
		payloadHash: string;
		receivedAt: string;
	}): Promise<'RECORDED' | 'DUPLICATE' | 'UNKNOWN'>;
}

interface SubmissionRow {
	idempotency_key: string;
	operation_key: string;
	idempotency_hash: string;
	payload_hash: string;
	status: ResendSubmissionState;
	provider_email_id: string | null;
	failure_classification: string | null;
	response_status: number | null;
}

function submission(row: SubmissionRow): ResendSubmissionRecord {
	return {
		idempotencyKey: row.idempotency_key,
		operationKey: row.operation_key,
		idempotencyHash: row.idempotency_hash,
		payloadHash: row.payload_hash,
		status: row.status,
		providerEmailId: row.provider_email_id,
		failureClassification: row.failure_classification,
		responseStatus: row.response_status,
	};
}

export class D1ResendEmailRepository implements ResendEmailRepository {
	constructor(private readonly db: D1Database) {}

	async reserve(notification: ReviewNotification, payloadHash: string, idempotencyHash: string, at: string): Promise<ResendReservationResult> {
		const operationKey = `external-review:v1:${notification.idempotencyKey}`;
		const inserted = await this.db.prepare(`INSERT OR IGNORE INTO resend_email_submissions (
			idempotency_key, operation_key, idempotency_hash, payload_hash, status, created_at, updated_at
		) SELECT ?, delivery.operation_key, ?, ?, 'PENDING', ?, ?
		FROM external_review_notification_deliveries AS delivery
		WHERE delivery.operation_key = ? AND delivery.idempotency_key = ?
		  AND delivery.batch_id = ? AND delivery.stage = ? AND delivery.kind = ?
		  AND delivery.message_text = ? AND delivery.review_url IS ?
		  AND delivery.status = 'PENDING'`)
			.bind(notification.idempotencyKey, idempotencyHash, payloadHash, at, at, operationKey,
				notification.idempotencyKey, notification.batchId, notification.stage,
				notification.kind, notification.message, notification.reviewUrl).run();
		if (inserted.meta.changes === 1) return 'ACQUIRED';
		const existing = await this.find(notification.idempotencyKey);
		if (!existing) return 'BLOCKED';
		if (existing.operationKey !== operationKey || existing.idempotencyHash !== idempotencyHash
			|| existing.payloadHash !== payloadHash) return 'CONFLICT';
		return existing.status;
	}

	async find(idempotencyKey: string): Promise<ResendSubmissionRecord | null> {
		const row = await this.db.prepare(`SELECT idempotency_key, operation_key, idempotency_hash, payload_hash, status,
			provider_email_id, failure_classification, response_status
			FROM resend_email_submissions WHERE idempotency_key = ?`)
			.bind(idempotencyKey).first<SubmissionRow>();
		return row ? submission(row) : null;
	}

	async countPending(batchId: string, stage: ReviewNotification['stage']): Promise<number> {
		const predicate = stage === 'TRIAGE'
			? "workflow_state = 'INGESTED'"
			: "workflow_state = 'READY_FOR_REVIEW'";
		const row = await this.db.prepare(`SELECT COUNT(*) AS count FROM editorial_batch_items
			WHERE batch_id = ? AND ${predicate}`).bind(batchId).first<{ count: number }>();
		return row?.count ?? 0;
	}

	async markAccepted(idempotencyKey: string, providerEmailId: string, responseStatus: number, at: string): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE resend_email_submissions
			SET provider_email_id = ?, response_status = ?, accepted_at = ?, updated_at = ?
			WHERE idempotency_key = ? AND status = 'PENDING' AND provider_email_id IS NULL`)
			.bind(providerEmailId, responseStatus, at, at, idempotencyKey).run();
		if (result.meta.changes === 1) return true;
		const existing = await this.find(idempotencyKey);
		return existing?.status === 'PENDING' && existing.providerEmailId === providerEmailId;
	}

	async markAmbiguous(idempotencyKey: string, classification: string, responseStatus: number | null, at: string): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE resend_email_submissions
			SET status = 'AMBIGUOUS', failure_classification = ?, response_status = ?, updated_at = ?
			WHERE idempotency_key = ? AND status = 'PENDING'`)
			.bind(classification, responseStatus, at, idempotencyKey).run();
		return result.meta.changes === 1;
	}

	async markFailed(idempotencyKey: string, classification: string, responseStatus: number | null, at: string): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE resend_email_submissions
			SET status = 'FAILED', failure_classification = ?, response_status = ?, updated_at = ?, failed_at = ?
			WHERE idempotency_key = ? AND status = 'PENDING'`)
			.bind(classification, responseStatus, at, at, idempotencyKey).run();
		return result.meta.changes === 1;
	}

	async recordProviderEvent(record: {
		eventId: string;
		providerEmailId: string;
		idempotencyHash: string;
		eventType: ResendProviderEventType;
		providerCreatedAt: string;
		payloadHash: string;
		receivedAt: string;
	}): Promise<'RECORDED' | 'DUPLICATE' | 'UNKNOWN'> {
		const targetDisposition = record.eventType === 'email.delivered'
			? 'DELIVERED'
			: record.eventType === 'email.delivery_delayed' ? 'DELAYED' : 'FAILED';
		const correlateSubmission = this.db.prepare(`UPDATE resend_email_submissions
			SET provider_email_id = COALESCE(provider_email_id, ?), accepted_at = COALESCE(accepted_at, ?), updated_at = ?
			WHERE idempotency_hash = ? AND (provider_email_id IS NULL OR provider_email_id = ?)`)
			.bind(record.providerEmailId, record.receivedAt, record.receivedAt,
				record.idempotencyHash, record.providerEmailId);
		const inserted = this.db.prepare(`INSERT OR IGNORE INTO resend_email_delivery_events (
			event_id, operation_key, provider_email_id, event_type, disposition,
			provider_created_at, payload_hash, received_at
		) SELECT ?, submission.operation_key, submission.provider_email_id, ?,
			CASE WHEN submission.status IN ('DELIVERED','FAILED') THEN 'IGNORED_TERMINAL' ELSE ? END,
			?, ?, ? FROM resend_email_submissions AS submission
			WHERE submission.provider_email_id = ? AND submission.idempotency_hash = ?`)
			.bind(record.eventId, record.eventType, targetDisposition, record.providerCreatedAt,
				record.payloadHash, record.receivedAt, record.providerEmailId, record.idempotencyHash);
		const updateSubmission = this.db.prepare(`UPDATE resend_email_submissions SET
			status = CASE
				WHEN ? = 'DELIVERED' THEN 'DELIVERED'
				WHEN ? = 'FAILED' THEN 'FAILED'
				ELSE status END,
			failure_classification = CASE WHEN ? = 'FAILED' THEN ? ELSE failure_classification END,
			updated_at = ?,
			delivered_at = CASE WHEN ? = 'DELIVERED' THEN ? ELSE delivered_at END,
			failed_at = CASE WHEN ? = 'FAILED' THEN ? ELSE failed_at END
			WHERE provider_email_id = ? AND status IN ('PENDING','AMBIGUOUS')
			AND EXISTS (SELECT 1 FROM resend_email_delivery_events WHERE event_id = ?
				AND disposition <> 'IGNORED_TERMINAL')`)
			.bind(targetDisposition, targetDisposition, targetDisposition,
				record.eventType.toUpperCase().replaceAll('.', '_'), record.receivedAt,
				targetDisposition, record.receivedAt, targetDisposition, record.receivedAt,
				record.providerEmailId, record.eventId);
		const correlateExternal = this.db.prepare(`UPDATE external_review_notification_deliveries
			SET provider_request_id = COALESCE(provider_request_id, ?), updated_at = ?
			WHERE operation_key = (SELECT operation_key FROM resend_email_submissions WHERE provider_email_id = ?)
			AND (provider_request_id IS NULL OR provider_request_id = ?)`)
			.bind(record.providerEmailId, record.receivedAt, record.providerEmailId, record.providerEmailId);
		const updateExternal = this.db.prepare(`UPDATE external_review_notification_deliveries SET
			status = CASE WHEN ? = 'DELIVERED' THEN 'DELIVERED' ELSE 'FAILED' END,
			failure_classification = CASE WHEN ? = 'FAILED' THEN ? ELSE NULL END,
			provider_request_id = COALESCE(provider_request_id, ?), updated_at = ?,
			delivered_at = CASE WHEN ? = 'DELIVERED' THEN ? ELSE NULL END
			WHERE operation_key = (SELECT operation_key FROM resend_email_submissions WHERE provider_email_id = ?)
			AND status IN ('PENDING','AMBIGUOUS') AND ? IN ('DELIVERED','FAILED')
			AND EXISTS (SELECT 1 FROM resend_email_delivery_events WHERE event_id = ?
				AND disposition <> 'IGNORED_TERMINAL')`)
			.bind(targetDisposition, targetDisposition, record.eventType.toUpperCase().replaceAll('.', '_'),
				record.providerEmailId, record.receivedAt, targetDisposition, record.receivedAt,
				record.providerEmailId, targetDisposition, record.eventId);
		const results = await this.db.batch([correlateSubmission, inserted, updateSubmission, correlateExternal, updateExternal]);
		if (results[1].meta.changes === 1) return 'RECORDED';
		const knownEvent = await this.db.prepare('SELECT 1 AS found FROM resend_email_delivery_events WHERE event_id = ?')
			.bind(record.eventId).first<{ found: number }>();
		if (knownEvent) return 'DUPLICATE';
		return 'UNKNOWN';
	}
}
