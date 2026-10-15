import type { ReviewReminderRepository } from './editorial-review-reminder-repository';
import type { ClaimedReviewReminder, EditorialReminderStage, ReviewReminderBatch, ReviewReminderKind, ReviewReminderStatus } from '../domain/editorial-review-reminder';

interface BatchRow {
	batch_id: string; stage: EditorialReminderStage; item_count: number; created_at: string;
	initial_sent_at: string | null; six_hour_sent_at: string | null;
	final_sent_at: string | null; resolved_at: string | null;
}

const sentColumn: Record<ReviewReminderKind, string> = {
	INITIAL: 'initial_sent_at', SIX_HOUR: 'six_hour_sent_at', FINAL: 'final_sent_at',
};

export class D1EditorialReviewReminderRepository implements ReviewReminderRepository {
	constructor(private readonly db: D1Database) {}

	async listUnresolved(limit: number): Promise<ReviewReminderBatch[]> {
		const rows = await this.db.prepare(`SELECT reminder.batch_id, reminder.stage,
			batch.item_count, reminder.created_at, reminder.initial_sent_at,
			reminder.six_hour_sent_at, reminder.final_sent_at, reminder.resolved_at
			FROM editorial_stage_reminders AS reminder
			JOIN editorial_batches AS batch ON batch.id = reminder.batch_id
			WHERE reminder.resolved_at IS NULL
			ORDER BY reminder.created_at, reminder.batch_id, reminder.stage LIMIT ?`)
			.bind(limit).all<BatchRow>();
		return rows.results.map((row) => ({
			batchId: row.batch_id, stage: row.stage, itemCount: row.item_count, createdAt: row.created_at,
			initialSentAt: row.initial_sent_at, sixHourSentAt: row.six_hour_sent_at,
			finalSentAt: row.final_sent_at, resolvedAt: row.resolved_at,
		}));
	}

	async countPending(batchId: string, stage: EditorialReminderStage): Promise<number> {
		const predicate = stage === 'TRIAGE'
			? "workflow_state = 'INGESTED'"
			: "workflow_state = 'READY_FOR_REVIEW'";
		const row = await this.db.prepare(`SELECT COUNT(*) AS count FROM editorial_batch_items
			WHERE batch_id = ? AND ${predicate}`).bind(batchId).first<{ count: number }>();
		return row?.count ?? 0;
	}

	async status(batchId: string, stage: EditorialReminderStage): Promise<ReviewReminderStatus> {
		const row = await this.db.prepare(`SELECT batch.item_count,
			EXISTS (SELECT 1 FROM routine_generation_batch_admissions AS admission
				WHERE admission.batch_id = batch.id) AS routine_admission,
			(SELECT COUNT(*) FROM editorial_batch_items AS item
				WHERE item.batch_id = batch.id AND item.workflow_state = 'INGESTED') AS triage_pending,
			(SELECT COUNT(DISTINCT event.source_intake_id) FROM editorial_workflow_events AS event
				WHERE event.batch_id = batch.id AND event.event_kind = 'INTAKE_SELECTED'
				AND event.detail = 'routine-generation:v1') AS selected_count,
			(SELECT COUNT(DISTINCT event.source_intake_id) FROM editorial_workflow_events AS event
				JOIN editorial_stage_reminders AS reminder ON reminder.batch_id = event.batch_id
					AND reminder.stage = 'FINAL_REVIEW'
				WHERE event.batch_id = batch.id AND event.event_kind = 'ARTICLE_READY_FOR_REVIEW'
				AND event.created_at <= reminder.created_at) AS ready_count,
			(SELECT COUNT(DISTINCT event.source_intake_id) FROM editorial_workflow_events AS event
				JOIN editorial_stage_reminders AS reminder ON reminder.batch_id = event.batch_id
					AND reminder.stage = 'FINAL_REVIEW'
				WHERE event.batch_id = batch.id AND event.event_kind = 'GENERATION_FAILED'
				AND event.created_at <= reminder.created_at) AS failed_count,
			(SELECT COUNT(*) FROM editorial_batch_items AS item
				WHERE item.batch_id = batch.id AND item.workflow_state = 'READY_FOR_REVIEW') AS review_pending
			FROM editorial_batches AS batch WHERE batch.id = ?`).bind(batchId).first<{
			item_count: number; routine_admission: number; triage_pending: number;
			selected_count: number; ready_count: number; failed_count: number; review_pending: number;
		}>();
		if (!row) return { pendingCount: 0, selectedCount: 0, readyCount: 0, failedCount: 0,
			generationSettled: false, routineAdmission: false };
		if (stage === 'TRIAGE') return {
			pendingCount: row.triage_pending, selectedCount: 0, readyCount: 0, failedCount: 0,
			generationSettled: false, routineAdmission: Boolean(row.routine_admission),
		};
		const routineAdmission = Boolean(row.routine_admission);
		const selectedCount = routineAdmission ? row.selected_count : row.item_count;
		return {
			pendingCount: row.review_pending,
			selectedCount,
			readyCount: row.ready_count,
			failedCount: row.failed_count,
			generationSettled: routineAdmission
				? selectedCount >= 1 && selectedCount <= 3 && row.ready_count + row.failed_count === selectedCount
				: row.item_count === 3 && row.ready_count === 3 && row.failed_count === 0,
			routineAdmission,
		};
	}

	async resolve(batchId: string, stage: EditorialReminderStage, resolvedAt: string, eventId: string): Promise<boolean> {
		const predicate = stage === 'TRIAGE'
			? "workflow_state = 'INGESTED'"
			: "workflow_state = 'READY_FOR_REVIEW'";
		const batchColumn = stage === 'TRIAGE' ? 'triage_completed_at' : 'final_review_completed_at';
		const results = await this.db.batch([
			this.db.prepare(`UPDATE editorial_stage_reminders SET resolved_at = ?, claim_kind = NULL,
				claim_token = NULL, claimed_at = NULL WHERE batch_id = ? AND stage = ? AND resolved_at IS NULL
				AND NOT EXISTS (SELECT 1 FROM editorial_batch_items WHERE batch_id = ? AND ${predicate})`)
				.bind(resolvedAt, batchId, stage, batchId),
			this.db.prepare(`UPDATE editorial_batches SET ${batchColumn} = ?
				WHERE id = ? AND EXISTS (SELECT 1 FROM editorial_stage_reminders
					WHERE batch_id = ? AND stage = ? AND resolved_at = ?)`)
				.bind(resolvedAt, batchId, batchId, stage, resolvedAt),
			this.db.prepare(`INSERT INTO editorial_workflow_events
				(id, batch_id, event_kind, reminder_stage, created_at)
				SELECT ?, ?, 'REMINDER_PHASE_RESOLVED', ?, ? WHERE changes() > 0`)
				.bind(eventId, batchId, stage, resolvedAt),
		]);
		return results[0].meta.changes === 1;
	}

	async claim(batchId: string, stage: EditorialReminderStage, kind: ReviewReminderKind, claimToken: string, claimedAt: string, staleBefore: string): Promise<ClaimedReviewReminder | null> {
		const dueClause = kind === 'INITIAL' ? 'initial_sent_at IS NULL'
			: kind === 'SIX_HOUR'
				? "initial_sent_at IS NOT NULL AND six_hour_sent_at IS NULL AND julianday(initial_sent_at) <= julianday(?, '-6 hours')"
				: "initial_sent_at IS NOT NULL AND final_sent_at IS NULL AND julianday(initial_sent_at) <= julianday(?, '-24 hours')";
		const bindings: unknown[] = [kind, claimToken, claimedAt, batchId, stage, staleBefore];
		if (kind !== 'INITIAL') bindings.push(claimedAt);
		const result = await this.db.prepare(`UPDATE editorial_stage_reminders
			SET claim_kind = ?, claim_token = ?, claimed_at = ?, last_error = NULL
			WHERE batch_id = ? AND stage = ? AND resolved_at IS NULL
			AND (claim_kind IS NULL OR claimed_at <= ?) AND ${dueClause}`)
			.bind(...bindings).run();
		return result.meta.changes === 1 ? { batchId, stage, kind, claimToken } : null;
	}

	async complete(claim: ClaimedReviewReminder, sentAt: string, eventId: string): Promise<boolean> {
		const column = sentColumn[claim.kind];
		const results = await this.db.batch([
			this.db.prepare(`UPDATE editorial_stage_reminders SET ${column} = ?, claim_kind = NULL,
				claim_token = NULL, claimed_at = NULL, last_error = NULL
				WHERE batch_id = ? AND stage = ? AND resolved_at IS NULL
				AND claim_kind = ? AND claim_token = ? AND ${column} IS NULL`)
				.bind(sentAt, claim.batchId, claim.stage, claim.kind, claim.claimToken),
			this.db.prepare(`INSERT INTO editorial_workflow_events
				(id, batch_id, event_kind, reminder_stage, reminder_kind, created_at)
				SELECT ?, ?, 'REMINDER_SENT', ?, ?, ? WHERE changes() > 0`)
				.bind(eventId, claim.batchId, claim.stage, claim.kind, sentAt),
		]);
		return results[0].meta.changes === 1;
	}

	async releaseFailed(claim: ClaimedReviewReminder, failedAt: string, eventId: string, classification: string): Promise<void> {
		await this.db.batch([
			this.db.prepare(`INSERT INTO editorial_workflow_events
				(id, batch_id, event_kind, reminder_stage, reminder_kind, detail, created_at)
				SELECT ?, ?, 'NOTIFICATION_FAILED', ?, ?, ?, ? WHERE EXISTS
				(SELECT 1 FROM editorial_stage_reminders WHERE batch_id = ? AND stage = ?
					AND claim_kind = ? AND claim_token = ?)`)
				.bind(eventId, claim.batchId, claim.stage, claim.kind, classification, failedAt,
					claim.batchId, claim.stage, claim.kind, claim.claimToken),
			this.db.prepare(`UPDATE editorial_stage_reminders SET claim_kind = NULL,
				claim_token = NULL, claimed_at = NULL, last_error = ?
				WHERE batch_id = ? AND stage = ? AND claim_kind = ? AND claim_token = ?`)
				.bind(classification, claim.batchId, claim.stage, claim.kind, claim.claimToken),
		]);
	}
}
