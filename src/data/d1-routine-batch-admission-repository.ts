import type { RoutineBatchAdmissionRepository } from './routine-batch-admission-repository';
import { ROUTINE_GENERATION_POLICY } from '../services/routine-generation-policy';

export class D1RoutineBatchAdmissionRepository implements RoutineBatchAdmissionRepository {
	constructor(private readonly db: D1Database) {}

	async admit(record: {
		operatingDate: string; timeZone: 'America/New_York'; batchNotBefore: string;
		actorEmail: string; admittedAt: string;
	}): Promise<string | null> {
		await this.db.prepare(`INSERT OR IGNORE INTO routine_generation_batch_admissions (
			operating_date, time_zone, batch_id, actor_email, admitted_at
		) SELECT ?, ?, batch.id, ?, ? FROM editorial_batches AS batch
		WHERE batch.created_at >= ? AND batch.item_count = 3
		AND (SELECT COUNT(*) FROM editorial_batch_items AS item WHERE item.batch_id = batch.id) = 3
		AND (SELECT COUNT(*) FROM editorial_batch_items AS item
			WHERE item.batch_id = batch.id AND item.workflow_state = 'SELECTED') = 3
		AND (SELECT COUNT(*) FROM editorial_batch_items AS item
			WHERE item.batch_id = batch.id AND EXISTS (
				SELECT 1 FROM editorial_workflow_events AS event
				WHERE event.batch_id = item.batch_id AND event.source_intake_id = item.source_intake_id
				AND event.event_kind = 'INTAKE_SELECTED' AND event.detail = ?
			)) = 3
		ORDER BY batch.created_at, batch.id LIMIT 1`)
			.bind(record.operatingDate, record.timeZone, record.actorEmail, record.admittedAt,
				record.batchNotBefore, ROUTINE_GENERATION_POLICY).run();
		const row = await this.db.prepare(`SELECT batch_id FROM routine_generation_batch_admissions
			WHERE operating_date = ? AND time_zone = ?`).bind(record.operatingDate, record.timeZone)
			.first<{ batch_id: string }>();
		return row?.batch_id ?? null;
	}
}
