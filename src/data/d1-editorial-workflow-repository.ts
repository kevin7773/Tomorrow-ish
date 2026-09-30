import type { EditorialWorkflowRepository } from './editorial-workflow-repository';
import type { EditorialBatch, EditorialBatchItem, EditorialWorkflowState } from '../domain/editorial-workflow';

interface ItemRow {
	batch_id: string; source_intake_id: string; ordinal: number; category_id: string;
	workflow_state: EditorialWorkflowState; selected_by_email: string | null; selected_at: string | null;
	candidate_id: string | null; story_id: string | null; failure_stage: string | null;
	failure_classification: string | null; created_at: string; updated_at: string;
}

function item(row: ItemRow): EditorialBatchItem {
	return {
		batchId: row.batch_id, intakeId: row.source_intake_id, ordinal: row.ordinal,
		categoryId: row.category_id, state: row.workflow_state,
		selectedByEmail: row.selected_by_email, selectedAt: row.selected_at,
		candidateId: row.candidate_id, storyId: row.story_id,
		failureStage: row.failure_stage, failureClassification: row.failure_classification,
		createdAt: row.created_at, updatedAt: row.updated_at,
	};
}

export class D1EditorialWorkflowRepository implements EditorialWorkflowRepository {
	constructor(private readonly db: D1Database) {}

	async listBatches(limit = 20): Promise<EditorialBatch[]> {
		const rows = await this.db.prepare(`SELECT id, item_count, created_at,
			triage_completed_at, final_review_completed_at FROM editorial_batches
			ORDER BY created_at DESC LIMIT ?`).bind(limit).all<{
			id: string; item_count: number; created_at: string;
			triage_completed_at: string | null; final_review_completed_at: string | null;
		}>();
		const batches: EditorialBatch[] = [];
		for (const row of rows.results) {
			const found = await this.findBatch(row.id);
			if (found) batches.push(found);
		}
		return batches;
	}

	async findBatch(id: string): Promise<EditorialBatch | null> {
		const row = await this.db.prepare(`SELECT id, item_count, created_at,
			triage_completed_at, final_review_completed_at FROM editorial_batches WHERE id = ?`)
			.bind(id).first<{ id: string; item_count: number; created_at: string; triage_completed_at: string | null; final_review_completed_at: string | null }>();
		if (!row) return null;
		const items = await this.db.prepare('SELECT * FROM editorial_batch_items WHERE batch_id = ? ORDER BY ordinal')
			.bind(id).all<ItemRow>();
		return { id: row.id, itemCount: row.item_count, createdAt: row.created_at,
			triageCompletedAt: row.triage_completed_at, finalReviewCompletedAt: row.final_review_completed_at,
			items: items.results.map(item) };
	}

	async findItem(batchId: string, intakeId: string): Promise<EditorialBatchItem | null> {
		const row = await this.db.prepare('SELECT * FROM editorial_batch_items WHERE batch_id = ? AND source_intake_id = ?')
			.bind(batchId, intakeId).first<ItemRow>();
		return row ? item(row) : null;
	}

	async listProcessable(limit: number): Promise<EditorialBatchItem[]> {
		const rows = await this.db.prepare(`SELECT * FROM editorial_batch_items
			WHERE workflow_state IN ('SELECTED', 'GENERATING') ORDER BY selected_at, ordinal LIMIT ?`)
			.bind(limit).all<ItemRow>();
		return rows.results.map(item);
	}

	async select(batchId: string, intakeId: string, actorEmail: string, at: string, eventId: string): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'SELECTED', selected_by_email = ?,
				selected_at = ?, updated_at = ? WHERE batch_id = ? AND source_intake_id = ? AND workflow_state = 'INGESTED'`)
				.bind(actorEmail, at, at, batchId, intakeId),
			this.event(eventId, batchId, intakeId, null, 'INTAKE_SELECTED', null, at),
		]);
		return results[0].meta.changes === 1;
	}

	async rejectIntake(batchId: string, intakeId: string, actorEmail: string, at: string, eventId: string): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'REJECTED', rejected_by_email = ?,
				rejected_at = ?, updated_at = ? WHERE batch_id = ? AND source_intake_id = ? AND workflow_state = 'INGESTED'`)
				.bind(actorEmail, at, at, batchId, intakeId),
			this.db.prepare(`UPDATE source_intakes SET satire_suitability = 'UNSUITABLE',
				suitability_reason = 'Rejected during intake triage.', assessment_reviewed_by_email = ?,
				assessment_reviewed_at = ?, updated_by_email = ?, updated_at = ?
				WHERE id = ? AND EXISTS (SELECT 1 FROM editorial_batch_items
					WHERE batch_id = ? AND source_intake_id = ? AND workflow_state = 'REJECTED' AND rejected_at = ?)`)
				.bind(actorEmail, at, actorEmail, at, intakeId, batchId, intakeId, at),
			this.event(eventId, batchId, intakeId, null, 'INTAKE_REJECTED', null, at),
		]);
		return results[0].meta.changes === 1;
	}

	async markGenerating(batchId: string, intakeId: string, at: string, eventId: string): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'GENERATING', updated_at = ?
				WHERE batch_id = ? AND source_intake_id = ? AND workflow_state = 'SELECTED'`)
				.bind(at, batchId, intakeId),
			this.event(eventId, batchId, intakeId, null, 'GENERATION_STARTED', null, at),
		]);
		return results[0].meta.changes === 1;
	}

	async attachCandidate(batchId: string, intakeId: string, candidateId: string, at: string): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE editorial_batch_items SET candidate_id = ?, updated_at = ?
			WHERE batch_id = ? AND source_intake_id = ? AND workflow_state = 'GENERATING'
			AND candidate_id IS NULL`).bind(candidateId, at, batchId, intakeId).run();
		return result.meta.changes === 1;
	}

	async findGeneratedCandidateId(intakeId: string, modelRunId: string): Promise<string | null> {
		const row = await this.db.prepare(`SELECT id FROM satire_candidates
			WHERE source_intake_id = ? AND origin_model_run_id = ? ORDER BY generation_ordinal LIMIT 1`)
			.bind(intakeId, modelRunId).first<{ id: string }>();
		return row?.id ?? null;
	}

	async createReviewStory(record: { batchId: string; intakeId: string; candidateId: string; storyId: string; slug: string; editionDate: string; socialExcerpt: string; actorEmail: string; at: string; eventId: string }): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`INSERT INTO stories (
				id, slug, headline, deck, body_markdown, edition_date, category_id, status,
				social_excerpt, tags_json, created_at, updated_at, origin_candidate_id
			) SELECT ?, ?, proposed_headline, proposed_deck, draft_body_markdown, ?, category_id,
				'REVIEW', ?, '[]', ?, ?, id FROM satire_candidates
				WHERE id = ? AND source_intake_id = ? AND status = 'DRAFT'
				AND body_generation_state = 'SUCCEEDED' AND trim(draft_body_markdown) <> ''
				AND NOT EXISTS (SELECT 1 FROM stories WHERE origin_candidate_id = satire_candidates.id)`)
				.bind(record.storyId, record.slug, record.editionDate, record.socialExcerpt,
					record.at, record.at, record.candidateId, record.intakeId),
			this.db.prepare(`INSERT INTO sources (id, story_id, title, url, publisher, published_at, created_at)
				SELECT ? || ':' || reference.id, ?, reference.source_title, reference.source_url,
				reference.publisher_name, reference.published_at, ? FROM source_references AS reference
				WHERE reference.source_intake_id = ? AND EXISTS (SELECT 1 FROM stories WHERE id = ?)`)
				.bind(record.candidateId, record.storyId, record.at, record.intakeId, record.storyId),
			this.db.prepare(`UPDATE editorial_batch_items SET story_id = ?, updated_at = ?
				WHERE batch_id = ? AND source_intake_id = ? AND candidate_id = ?
				AND workflow_state = 'GENERATING' AND EXISTS (SELECT 1 FROM stories WHERE id = ? AND status = 'REVIEW')`)
				.bind(record.storyId, record.at, record.batchId, record.intakeId, record.candidateId, record.storyId),
			this.db.prepare(`INSERT INTO editorial_audit_log
				(id, actor_email, entity_type, entity_id, action, from_status, to_status, created_at)
				SELECT ?, ?, 'STORY', ?, 'CREATED_FOR_FINAL_REVIEW', 'DRAFT', 'REVIEW', ?
				WHERE EXISTS (SELECT 1 FROM stories WHERE id = ? AND status = 'REVIEW')`)
				.bind(`${record.eventId}:audit`, record.actorEmail, record.storyId, record.at, record.storyId),
			this.event(record.eventId, record.batchId, record.intakeId, record.storyId, 'BODY_GENERATED', null, record.at),
		]);
		return results[0].meta.changes === 1 && results[2].meta.changes === 1;
	}

	async markReady(batchId: string, intakeId: string, storyId: string, at: string, eventId: string): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'READY_FOR_REVIEW', updated_at = ?
				WHERE batch_id = ? AND source_intake_id = ? AND story_id = ? AND workflow_state = 'GENERATING'
				AND EXISTS (SELECT 1 FROM article_images WHERE story_id = ? AND status = 'GENERATED')`)
				.bind(at, batchId, intakeId, storyId, storyId),
			this.event(eventId, batchId, intakeId, storyId, 'ARTICLE_READY_FOR_REVIEW', null, at),
		]);
		return results[0].meta.changes === 1;
	}

	async markFailed(batchId: string, intakeId: string, stage: string, classification: string, at: string, eventId: string): Promise<void> {
		await this.db.batch([
			this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'FAILED', failure_stage = ?,
				failure_classification = ?, updated_at = ? WHERE batch_id = ? AND source_intake_id = ?
				AND workflow_state IN ('SELECTED', 'GENERATING')`)
				.bind(stage, classification, at, batchId, intakeId),
			this.event(eventId, batchId, intakeId, null, 'GENERATION_FAILED', `${stage}:${classification}`, at),
		]);
	}

	async retryFailed(batchId: string, intakeId: string, actorEmail: string, at: string, eventId: string): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'SELECTED',
				failure_stage = NULL, failure_classification = NULL, updated_at = ?
				WHERE batch_id = ? AND source_intake_id = ? AND workflow_state = 'FAILED'`)
				.bind(at, batchId, intakeId),
			this.event(eventId, batchId, intakeId, null, 'GENERATION_RETRY_REQUESTED', actorEmail, at),
		]);
		return results[0].meta.changes === 1;
	}

	async ensureFinalReminder(batchId: string, at: string, eventId: string): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`INSERT OR IGNORE INTO editorial_stage_reminders (batch_id, stage, created_at)
				SELECT ?, 'FINAL_REVIEW', ? WHERE EXISTS (SELECT 1 FROM editorial_batch_items
					WHERE batch_id = ? AND workflow_state = 'READY_FOR_REVIEW')
				AND NOT EXISTS (SELECT 1 FROM editorial_batch_items WHERE batch_id = ?
					AND workflow_state IN ('SELECTED', 'GENERATING'))`)
				.bind(batchId, at, batchId, batchId),
			this.event(eventId, batchId, null, null, 'FINAL_REVIEW_PHASE_CREATED', null, at),
		]);
		return results[0].meta.changes === 1;
	}

	async publishFinal(record: { batchId: string; intakeId: string; storyId: string; actorEmail: string; at: string; eventId: string; auditId: string }): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`UPDATE stories SET status = 'PUBLISHED', published_at = ?, updated_at = ?
				WHERE id = ? AND status = 'REVIEW' AND published_at IS NULL AND og_image_key IS NOT NULL
				AND trim(headline) <> '' AND trim(body_markdown) <> ''`)
				.bind(record.at, record.at, record.storyId),
			this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'PUBLISHED', updated_at = ?
				WHERE batch_id = ? AND source_intake_id = ? AND story_id = ?
				AND workflow_state = 'READY_FOR_REVIEW' AND EXISTS
				(SELECT 1 FROM stories WHERE id = ? AND status = 'PUBLISHED')`)
				.bind(record.at, record.batchId, record.intakeId, record.storyId, record.storyId),
			this.db.prepare(`INSERT INTO editorial_audit_log
				(id, actor_email, entity_type, entity_id, action, from_status, to_status, created_at)
				SELECT ?, ?, 'STORY', ?, 'PUBLISHED', 'REVIEW', 'PUBLISHED', ?
				WHERE EXISTS (SELECT 1 FROM stories WHERE id = ? AND status = 'PUBLISHED' AND published_at = ?)`)
				.bind(record.auditId, record.actorEmail, record.storyId, record.at, record.storyId, record.at),
			this.event(record.eventId, record.batchId, record.intakeId, record.storyId, 'ARTICLE_PUBLISHED', null, record.at),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}

	async rejectFinal(record: { batchId: string; intakeId: string; storyId: string; actorEmail: string; at: string; eventId: string; auditId: string }): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`UPDATE stories SET status = 'REJECTED', updated_at = ?
				WHERE id = ? AND status = 'REVIEW' AND published_at IS NULL`)
				.bind(record.at, record.storyId),
			this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'REJECTED',
				rejected_by_email = ?, rejected_at = ?, updated_at = ? WHERE batch_id = ?
				AND source_intake_id = ? AND story_id = ? AND workflow_state = 'READY_FOR_REVIEW'
				AND EXISTS (SELECT 1 FROM stories WHERE id = ? AND status = 'REJECTED')`)
				.bind(record.actorEmail, record.at, record.at, record.batchId, record.intakeId, record.storyId, record.storyId),
			this.db.prepare(`INSERT INTO editorial_audit_log
				(id, actor_email, entity_type, entity_id, action, from_status, to_status, created_at)
				SELECT ?, ?, 'STORY', ?, 'STATUS_CHANGED', 'REVIEW', 'REJECTED', ?
				WHERE EXISTS (SELECT 1 FROM stories WHERE id = ? AND status = 'REJECTED')`)
				.bind(record.auditId, record.actorEmail, record.storyId, record.at, record.storyId),
			this.event(record.eventId, record.batchId, record.intakeId, record.storyId, 'ARTICLE_REJECTED', null, record.at),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}

	async recordEvent(record: { id: string; batchId: string; intakeId: string; storyId: string | null; kind: string; detail?: string | null; at: string }): Promise<void> {
		await this.db.prepare(`INSERT OR IGNORE INTO editorial_workflow_events
			(id, batch_id, source_intake_id, story_id, event_kind, detail, created_at)
			SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM editorial_batches WHERE id = ?)`)
			.bind(record.id, record.batchId, record.intakeId, record.storyId, record.kind,
				record.detail ?? null, record.at, record.batchId).run();
	}

	private event(id: string, batchId: string, intakeId: string | null, storyId: string | null, kind: string, detail: string | null, at: string): D1PreparedStatement {
		return this.db.prepare(`INSERT OR IGNORE INTO editorial_workflow_events
			(id, batch_id, source_intake_id, story_id, event_kind, detail, created_at)
			SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0
			AND EXISTS (SELECT 1 FROM editorial_batches WHERE id = ?)`)
			.bind(id, batchId, intakeId, storyId, kind, detail, at, batchId);
	}
}
