import type { ResendProviderEventType } from './resend-email-repository';

export type NotificationAcceptanceTestState = 'PENDING' | 'DELIVERED' | 'FAILED' | 'AMBIGUOUS';
export type NotificationAcceptanceTestReservation = 'ACQUIRED' | NotificationAcceptanceTestState | 'CONFLICT';

export interface NotificationAcceptanceTestRecord {
	id: string;
	authorizationId: string;
	idempotencyKey: string;
	status: NotificationAcceptanceTestState;
	actorEmail: string;
	providerEmailId: string | null;
	failureClassification: string | null;
	responseStatus: number | null;
	authorizedAt: string;
	updatedAt: string;
}

export interface NotificationAcceptanceTestRepository {
	reserve(record: {
		id: string; eventId: string; authorizationId: string; operationKey: string;
		idempotencyKey: string; idempotencyHash: string; payloadHash: string;
		actorEmail: string; authorizedAt: string;
	}): Promise<NotificationAcceptanceTestReservation>;
	find(idempotencyKey: string): Promise<NotificationAcceptanceTestRecord | null>;
	listRecent(limit: number): Promise<NotificationAcceptanceTestRecord[]>;
	markAccepted(record: { idempotencyKey: string; eventId: string; providerEmailId: string;
		responseStatus: number; at: string }): Promise<boolean>;
	markAmbiguous(record: { idempotencyKey: string; eventId: string; classification: string;
		responseStatus: number | null; providerEmailId?: string | null; at: string }): Promise<boolean>;
	markFailed(record: { idempotencyKey: string; eventId: string; classification: string;
		responseStatus: number | null; at: string }): Promise<boolean>;
	recordProviderEvent(record: {
		eventId: string; providerEmailId: string; idempotencyHash: string;
		eventType: ResendProviderEventType; providerCreatedAt: string;
		payloadHash: string; receivedAt: string;
	}): Promise<'RECORDED' | 'DUPLICATE' | 'UNKNOWN'>;
}

interface Row {
	id: string; authorization_id: string; idempotency_key: string;
	status: NotificationAcceptanceTestState; actor_email: string;
	provider_email_id: string | null; failure_classification: string | null;
	response_status: number | null; authorized_at: string; updated_at: string;
}

function fromRow(row: Row): NotificationAcceptanceTestRecord {
	return { id: row.id, authorizationId: row.authorization_id, idempotencyKey: row.idempotency_key,
		status: row.status, actorEmail: row.actor_email, providerEmailId: row.provider_email_id,
		failureClassification: row.failure_classification, responseStatus: row.response_status,
		authorizedAt: row.authorized_at, updatedAt: row.updated_at };
}

export class D1NotificationAcceptanceTestRepository implements NotificationAcceptanceTestRepository {
	constructor(private readonly db: D1Database) {}

	async reserve(record: {
		id: string; eventId: string; authorizationId: string; operationKey: string;
		idempotencyKey: string; idempotencyHash: string; payloadHash: string;
		actorEmail: string; authorizedAt: string;
	}): Promise<NotificationAcceptanceTestReservation> {
		const results = await this.db.batch([
			this.db.prepare(`INSERT OR IGNORE INTO editorial_notification_acceptance_tests (
				id, authorization_id, operation_key, idempotency_key, idempotency_hash, payload_hash,
				purpose, actor_email, status, authorized_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'ACCEPTANCE_TEST', ?, 'PENDING', ?, ?)`)
				.bind(record.id, record.authorizationId, record.operationKey, record.idempotencyKey,
					record.idempotencyHash, record.payloadHash, record.actorEmail,
					record.authorizedAt, record.authorizedAt),
			this.db.prepare(`INSERT OR IGNORE INTO editorial_notification_acceptance_test_events (
				id, acceptance_test_id, event_kind, actor_email, created_at
			) SELECT ?, id, 'AUTHORIZED', actor_email, authorized_at
			FROM editorial_notification_acceptance_tests WHERE id = ? AND authorization_id = ?`)
				.bind(record.eventId, record.id, record.authorizationId),
		]);
		if (results[0].meta.changes === 1 && results[1].meta.changes === 1) return 'ACQUIRED';
		const existing = await this.find(record.idempotencyKey);
		if (!existing) return 'CONFLICT';
		const identity = await this.db.prepare(`SELECT operation_key, idempotency_hash, payload_hash
			FROM editorial_notification_acceptance_tests WHERE idempotency_key = ?`)
			.bind(record.idempotencyKey).first<{ operation_key: string; idempotency_hash: string; payload_hash: string }>();
		if (!identity || existing.authorizationId !== record.authorizationId
			|| existing.actorEmail !== record.actorEmail || identity.operation_key !== record.operationKey
			|| identity.idempotency_hash !== record.idempotencyHash || identity.payload_hash !== record.payloadHash) {
			return 'CONFLICT';
		}
		return existing.status;
	}

	async find(idempotencyKey: string): Promise<NotificationAcceptanceTestRecord | null> {
		const row = await this.db.prepare(`SELECT id, authorization_id, idempotency_key, status, actor_email,
			provider_email_id, failure_classification, response_status, authorized_at, updated_at
			FROM editorial_notification_acceptance_tests WHERE idempotency_key = ?`)
			.bind(idempotencyKey).first<Row>();
		return row ? fromRow(row) : null;
	}

	async listRecent(limit: number): Promise<NotificationAcceptanceTestRecord[]> {
		const rows = await this.db.prepare(`SELECT id, authorization_id, idempotency_key, status, actor_email,
			provider_email_id, failure_classification, response_status, authorized_at, updated_at
			FROM editorial_notification_acceptance_tests ORDER BY authorized_at DESC, id DESC LIMIT ?`)
			.bind(Math.max(1, Math.min(limit, 20))).all<Row>();
		return rows.results.map(fromRow);
	}

	async markAccepted(record: { idempotencyKey: string; eventId: string; providerEmailId: string;
		responseStatus: number; at: string }): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`UPDATE editorial_notification_acceptance_tests
				SET provider_email_id = ?, response_status = ?, provider_accepted_at = ?, updated_at = ?
				WHERE idempotency_key = ? AND status = 'PENDING' AND provider_email_id IS NULL`)
				.bind(record.providerEmailId, record.responseStatus, record.at, record.at, record.idempotencyKey),
			this.db.prepare(`INSERT OR IGNORE INTO editorial_notification_acceptance_test_events (
				id, acceptance_test_id, event_kind, provider_email_id, response_status, created_at
			) SELECT ?, id, 'PROVIDER_ACCEPTED', ?, ?, ?
			FROM editorial_notification_acceptance_tests
			WHERE idempotency_key = ? AND provider_email_id = ?`)
				.bind(record.eventId, record.providerEmailId, record.responseStatus, record.at,
					record.idempotencyKey, record.providerEmailId),
		]);
		if (results[0].meta.changes === 1 && results[1].meta.changes === 1) return true;
		const existing = await this.find(record.idempotencyKey);
		return existing?.status === 'PENDING' && existing.providerEmailId === record.providerEmailId;
	}

	private async finish(record: { idempotencyKey: string; eventId: string; classification: string;
		responseStatus: number | null; providerEmailId?: string | null; at: string },
		status: 'FAILED' | 'AMBIGUOUS'): Promise<boolean> {
		const kind = status === 'FAILED' ? 'PROVIDER_FAILED' : 'PROVIDER_AMBIGUOUS';
		const results = await this.db.batch([
			this.db.prepare(`UPDATE editorial_notification_acceptance_tests SET
				status = ?, failure_classification = ?, response_status = ?,
				provider_email_id = COALESCE(provider_email_id, ?), updated_at = ?,
				failed_at = CASE WHEN ? = 'FAILED' THEN ? ELSE NULL END
				WHERE idempotency_key = ? AND status = 'PENDING'`)
				.bind(status, record.classification, record.responseStatus, record.providerEmailId ?? null,
					record.at, status, record.at, record.idempotencyKey),
			this.db.prepare(`INSERT OR IGNORE INTO editorial_notification_acceptance_test_events (
				id, acceptance_test_id, event_kind, provider_email_id, classification, response_status, created_at
			) SELECT ?, id, ?, provider_email_id, ?, ?, ?
			FROM editorial_notification_acceptance_tests WHERE idempotency_key = ? AND status = ?`)
				.bind(record.eventId, kind, record.classification, record.responseStatus, record.at,
					record.idempotencyKey, status),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}

	markAmbiguous(record: { idempotencyKey: string; eventId: string; classification: string;
		responseStatus: number | null; providerEmailId?: string | null; at: string }) {
		return this.finish(record, 'AMBIGUOUS');
	}

	markFailed(record: { idempotencyKey: string; eventId: string; classification: string;
		responseStatus: number | null; at: string }) {
		return this.finish(record, 'FAILED');
	}

	async recordProviderEvent(record: {
		eventId: string; providerEmailId: string; idempotencyHash: string;
		eventType: ResendProviderEventType; providerCreatedAt: string;
		payloadHash: string; receivedAt: string;
	}): Promise<'RECORDED' | 'DUPLICATE' | 'UNKNOWN'> {
		const disposition = record.eventType === 'email.delivered' ? 'DELIVERED'
			: record.eventType === 'email.delivery_delayed' ? 'DELAYED' : 'FAILED';
		const correlated = this.db.prepare(`UPDATE editorial_notification_acceptance_tests
			SET provider_email_id = COALESCE(provider_email_id, ?), updated_at = ?
			WHERE idempotency_hash = ? AND (provider_email_id IS NULL OR provider_email_id = ?)`)
			.bind(record.providerEmailId, record.receivedAt, record.idempotencyHash, record.providerEmailId);
		const event = this.db.prepare(`INSERT OR IGNORE INTO editorial_notification_acceptance_test_events (
			id, acceptance_test_id, event_kind, provider_event_id, provider_email_id,
			classification, payload_hash, created_at
		) SELECT ?, test.id,
			CASE WHEN test.status IN ('DELIVERED','FAILED') THEN 'IGNORED_TERMINAL'
				WHEN ? = 'DELIVERED' THEN 'EMAIL_DELIVERED'
				WHEN ? = 'DELAYED' THEN 'EMAIL_DELAYED' ELSE 'EMAIL_FAILED' END,
			?, ?, CASE WHEN ? = 'FAILED' THEN ? ELSE NULL END, ?, ?
		FROM editorial_notification_acceptance_tests AS test
		WHERE test.provider_email_id = ? AND test.idempotency_hash = ?`)
			.bind(record.eventId, disposition, disposition, record.eventId, record.providerEmailId,
				disposition, record.eventType.toUpperCase().replaceAll('.', '_'), record.payloadHash,
				record.receivedAt, record.providerEmailId, record.idempotencyHash);
		const update = this.db.prepare(`UPDATE editorial_notification_acceptance_tests SET
			status = CASE WHEN ? = 'DELIVERED' THEN 'DELIVERED'
				WHEN ? = 'FAILED' THEN 'FAILED' ELSE status END,
			failure_classification = CASE WHEN ? = 'FAILED' THEN ? ELSE failure_classification END,
			updated_at = ?, delivered_at = CASE WHEN ? = 'DELIVERED' THEN ? ELSE delivered_at END,
			failed_at = CASE WHEN ? = 'FAILED' THEN ? ELSE failed_at END
			WHERE provider_email_id = ? AND status IN ('PENDING','AMBIGUOUS')
			AND EXISTS (SELECT 1 FROM editorial_notification_acceptance_test_events
				WHERE provider_event_id = ? AND event_kind <> 'IGNORED_TERMINAL')`)
			.bind(disposition, disposition, disposition,
				record.eventType.toUpperCase().replaceAll('.', '_'), record.receivedAt,
				disposition, record.receivedAt, disposition, record.receivedAt,
				record.providerEmailId, record.eventId);
		const results = await this.db.batch([correlated, event, update]);
		if (results[1].meta.changes === 1) return 'RECORDED';
		const duplicate = await this.db.prepare(`SELECT 1 AS found
			FROM editorial_notification_acceptance_test_events WHERE provider_event_id = ?`)
			.bind(record.eventId).first<{ found: number }>();
		return duplicate ? 'DUPLICATE' : 'UNKNOWN';
	}
}
