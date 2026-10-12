import type { CandidateSelection, CandidateSelectionContext, EditorialWorkflowRepository } from './editorial-workflow-repository';
import type { EditorialBatch, EditorialBatchItem, EditorialWorkflowState } from '../domain/editorial-workflow';
import type { PublicationReadiness } from '../domain/publication-integrity';
import { SMOKE_BATCH_ID, SMOKE_INTAKE_ID } from '../services/editorial-smoke-target';
import { PUBLICATION_READINESS_SQL, PUBLISHABLE_STORY_PREDICATE } from './publication-integrity';

interface ItemRow {
	batch_id: string; source_intake_id: string; ordinal: number; category_id: string;
	workflow_state: EditorialWorkflowState; selected_by_email: string | null; selected_at: string | null;
	candidate_id: string | null; story_id: string | null; failure_stage: string | null;
	failure_classification: string | null; lease_owner: string | null; lease_acquired_at: string | null;
	lease_expires_at: string | null; attempt_count: number; retry_attempt: number;
	created_at: string; updated_at: string;
}

interface CandidateSelectionRow {
	batch_id: string; source_intake_id: string; normalized_event_version_id: string;
	candidate_id: string; selected_by_email: string; selected_at: string; revision: number;
}

function selection(row: CandidateSelectionRow): CandidateSelection {
	return { batchId: row.batch_id, intakeId: row.source_intake_id,
		normalizedEventVersionId: row.normalized_event_version_id, candidateId: row.candidate_id,
		selectedByEmail: row.selected_by_email, selectedAt: row.selected_at, revision: row.revision };
}

function item(row: ItemRow): EditorialBatchItem {
	return {
		batchId: row.batch_id, intakeId: row.source_intake_id, ordinal: row.ordinal,
		categoryId: row.category_id, state: row.workflow_state,
		selectedByEmail: row.selected_by_email, selectedAt: row.selected_at,
		candidateId: row.candidate_id, storyId: row.story_id,
		failureStage: row.failure_stage, failureClassification: row.failure_classification,
		leaseOwner: row.lease_owner, leaseAcquiredAt: row.lease_acquired_at,
		leaseExpiresAt: row.lease_expires_at, attemptCount: row.attempt_count, retryAttempt: row.retry_attempt,
		createdAt: row.created_at, updatedAt: row.updated_at,
	};
}

export class D1EditorialWorkflowRepository implements EditorialWorkflowRepository {
	constructor(private readonly db: D1Database) {}

	async listBatches(limit = 20): Promise<EditorialBatch[]> {
		const rows = await this.db.prepare(`SELECT batch.id, batch.item_count, batch.created_at,
			batch.triage_completed_at, batch.final_review_completed_at FROM editorial_batches AS batch
			WHERE EXISTS (SELECT 1 FROM editorial_batch_items AS item
				WHERE item.batch_id = batch.id AND item.workflow_state IN (
					'INGESTED', 'SELECTED', 'GENERATING', 'READY_FOR_REVIEW', 'FAILED'
				))
			ORDER BY batch.created_at DESC LIMIT ?`).bind(limit).all<{
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

	async findCandidateSelection(batchId: string, intakeId: string): Promise<CandidateSelection | null> {
		const row = await this.db.prepare('SELECT * FROM editorial_candidate_selections WHERE batch_id = ? AND source_intake_id = ?')
			.bind(batchId, intakeId).first<CandidateSelectionRow>();
		return row ? selection(row) : null;
	}

	async isAcceptedNormalization(versionId: string, intakeId: string): Promise<boolean> {
		const row = await this.db.prepare(`SELECT 1 AS present FROM normalized_event_versions
			WHERE id = ? AND source_intake_id = ? AND review_state = 'ACCEPTED' LIMIT 1`)
			.bind(versionId, intakeId).first<{ present: number }>();
		return row?.present === 1;
	}

	async findCandidateSelectionContext(candidateId: string): Promise<CandidateSelectionContext | null> {
		const row = await this.db.prepare(`SELECT item.batch_id, item.source_intake_id,
			candidate.normalized_event_version_id, selection.candidate_id AS selected_candidate_id,
			selection.selected_by_email, selection.selected_at
			FROM satire_candidates AS candidate
			JOIN editorial_batch_items AS item ON item.source_intake_id = candidate.source_intake_id
			LEFT JOIN editorial_candidate_selections AS selection ON selection.batch_id = item.batch_id
			WHERE candidate.id = ? AND candidate.normalized_event_version_id IS NOT NULL`).bind(candidateId).first<{
			batch_id: string; source_intake_id: string; normalized_event_version_id: string;
			selected_candidate_id: string | null; selected_by_email: string | null; selected_at: string | null;
		}>();
		return row ? { batchId: row.batch_id, intakeId: row.source_intake_id,
			normalizedEventVersionId: row.normalized_event_version_id,
			selectedCandidateId: row.selected_candidate_id, selectedByEmail: row.selected_by_email,
			selectedAt: row.selected_at } : null;
	}

	async selectCandidate(record: { id: string; batchId: string; intakeId: string; normalizedEventVersionId: string; candidateId: string; actorEmail: string; at: string; reason: string | null }): Promise<CandidateSelection | null> {
		await this.db.batch([
			this.db.prepare(`INSERT OR IGNORE INTO editorial_candidate_selections (
				batch_id, source_intake_id, normalized_event_version_id, candidate_id,
				previous_candidate_id, selected_by_email, selected_at, revision
			) SELECT ?, ?, ?, ?, NULL, ?, ?, 1
			WHERE EXISTS (SELECT 1 FROM editorial_batch_items AS item
				WHERE item.batch_id = ? AND item.source_intake_id = ?
				AND item.workflow_state IN ('SELECTED', 'GENERATING') AND item.story_id IS NULL)
			AND EXISTS (SELECT 1 FROM normalized_event_versions AS version
				WHERE version.id = ? AND version.source_intake_id = ? AND version.review_state = 'ACCEPTED')
			AND EXISTS (SELECT 1 FROM satire_candidates AS candidate
				WHERE candidate.id = ? AND candidate.source_intake_id = ?
				AND candidate.normalized_event_version_id = ? AND candidate.status = 'DRAFT'
				AND candidate.archived_at IS NULL AND candidate.body_generation_state = 'NOT_REQUESTED'
				AND trim(candidate.draft_body_markdown) = ''
				AND NOT EXISTS (SELECT 1 FROM candidate_body_generation_runs AS run WHERE run.candidate_id = candidate.id))`)
				.bind(record.batchId, record.intakeId, record.normalizedEventVersionId, record.candidateId,
					record.actorEmail, record.at, record.batchId, record.intakeId,
					record.normalizedEventVersionId, record.intakeId, record.candidateId, record.intakeId,
					record.normalizedEventVersionId),
			this.db.prepare(`UPDATE editorial_candidate_selections
				SET previous_candidate_id = candidate_id, candidate_id = ?, normalized_event_version_id = ?,
					source_intake_id = ?, selected_by_email = ?, selected_at = ?, revision = revision + 1
				WHERE batch_id = ? AND source_intake_id = ? AND candidate_id <> ? AND ? IS NOT NULL
				AND EXISTS (SELECT 1 FROM editorial_batch_items AS item
					WHERE item.batch_id = ? AND item.source_intake_id = ?
					AND item.workflow_state IN ('SELECTED', 'GENERATING') AND item.story_id IS NULL)
				AND EXISTS (SELECT 1 FROM normalized_event_versions AS version
					WHERE version.id = ? AND version.source_intake_id = ? AND version.review_state = 'ACCEPTED')
				AND EXISTS (SELECT 1 FROM satire_candidates AS candidate
					WHERE candidate.id = ? AND candidate.source_intake_id = ?
					AND candidate.normalized_event_version_id = ? AND candidate.status = 'DRAFT'
					AND candidate.archived_at IS NULL AND candidate.body_generation_state = 'NOT_REQUESTED'
					AND trim(candidate.draft_body_markdown) = ''
					AND NOT EXISTS (SELECT 1 FROM candidate_body_generation_runs AS run WHERE run.candidate_id = candidate.id))
				AND EXISTS (SELECT 1 FROM satire_candidates AS current
					WHERE current.id = editorial_candidate_selections.candidate_id
					AND current.body_generation_state = 'NOT_REQUESTED' AND trim(current.draft_body_markdown) = ''
					AND NOT EXISTS (SELECT 1 FROM candidate_body_generation_runs AS run WHERE run.candidate_id = current.id))`)
				.bind(record.candidateId, record.normalizedEventVersionId, record.intakeId, record.actorEmail,
					record.at, record.batchId, record.intakeId, record.candidateId, record.reason, record.batchId, record.intakeId,
					record.normalizedEventVersionId, record.intakeId, record.candidateId, record.intakeId,
					record.normalizedEventVersionId),
			this.db.prepare(`INSERT OR IGNORE INTO editorial_candidate_selection_events (
				id, batch_id, source_intake_id, normalized_event_version_id, candidate_id,
				previous_candidate_id, selected_by_email, selected_at, revision, reason, event_kind
			) SELECT ?, batch_id, source_intake_id, normalized_event_version_id, candidate_id,
				previous_candidate_id, selected_by_email, selected_at, revision, ?,
				CASE WHEN previous_candidate_id IS NULL THEN 'SELECTED' ELSE 'SELECTION_CHANGED' END
				FROM editorial_candidate_selections WHERE batch_id = ? AND candidate_id = ?
				AND normalized_event_version_id = ? AND source_intake_id = ?
				AND selected_by_email = ? AND selected_at = ?`)
				.bind(record.id, record.reason, record.batchId, record.candidateId,
					record.normalizedEventVersionId, record.intakeId, record.actorEmail, record.at),
		]);
		const found = await this.findCandidateSelection(record.batchId, record.intakeId);
		return found?.candidateId === record.candidateId
			&& found.intakeId === record.intakeId
			&& found.normalizedEventVersionId === record.normalizedEventVersionId ? found : null;
	}

	async claimProcessable(record: { limit: number; owner: string; at: string; leaseExpiresAt: string; createEventId: () => string; target?: { batchId: string; intakeId: string } }): Promise<EditorialBatchItem[]> {
		const candidates = await this.db.prepare(`SELECT * FROM editorial_batch_items
			WHERE workflow_state IN ('SELECTED', 'GENERATING')
			AND (lease_owner IS NULL OR lease_expires_at <= ?)
			AND (? IS NULL OR (batch_id = ? AND source_intake_id = ?))
			ORDER BY CASE workflow_state WHEN 'SELECTED' THEN 0 ELSE 1 END,
				COALESCE(lease_expires_at, selected_at), ordinal LIMIT ?`)
			.bind(record.at, record.target?.batchId ?? null, record.target?.batchId ?? '',
				record.target?.intakeId ?? '', Math.max(record.limit * 8, record.limit)).all<ItemRow>();
		const claimed: EditorialBatchItem[] = [];
		for (const candidate of candidates.results) {
			if (claimed.length >= record.limit) break;
			const recovered = candidate.workflow_state === 'GENERATING';
			const results = await this.db.batch([
				this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'GENERATING', lease_owner = ?,
					lease_acquired_at = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
					WHERE batch_id = ? AND source_intake_id = ? AND workflow_state IN ('SELECTED', 'GENERATING')
					AND (lease_owner IS NULL OR lease_expires_at <= ?)`)
					.bind(record.owner, record.at, record.leaseExpiresAt, record.at,
						candidate.batch_id, candidate.source_intake_id, record.at),
				this.event(record.createEventId(), candidate.batch_id, candidate.source_intake_id, candidate.story_id,
					recovered ? 'GENERATION_LEASE_RECOVERED' : 'GENERATION_STARTED', record.owner, record.at),
			]);
			if (results[0].meta.changes === 1) {
				const found = await this.findItem(candidate.batch_id, candidate.source_intake_id);
				if (found) claimed.push(found);
			}
		}
		return claimed;
	}

	async renewLease(batchId: string, intakeId: string, owner: string, at: string, leaseExpiresAt: string): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE editorial_batch_items SET lease_expires_at = ?, updated_at = ?
			WHERE batch_id = ? AND source_intake_id = ? AND workflow_state = 'GENERATING'
			AND lease_owner = ? AND lease_expires_at > ?`).bind(leaseExpiresAt, at, batchId, intakeId, owner, at).run();
		return result.meta.changes === 1;
	}

	async reconcilePublished(record: { limit: number; actorEmail: string; at: string; createEventId: () => string; createAuditId: () => string }): Promise<number> {
		const rows = await this.db.prepare(`SELECT item.batch_id, item.source_intake_id,
			COALESCE(item.story_id, story.id) AS story_id, item.workflow_state,
			CASE WHEN EXISTS (SELECT 1 FROM article_images AS image
				WHERE image.story_id = story.id AND image.status = 'APPROVED')
				THEN 'APPROVED' ELSE 'LEGACY_MISSING_APPROVED_IMAGE' END AS image_evidence
			FROM editorial_batch_items AS item
			JOIN stories AS story ON story.id = item.story_id OR
				(item.story_id IS NULL AND item.candidate_id IS NOT NULL AND story.origin_candidate_id = item.candidate_id)
			WHERE item.workflow_state IN ('SELECTED', 'GENERATING', 'READY_FOR_REVIEW', 'FAILED')
			AND story.status = 'PUBLISHED'
			ORDER BY item.updated_at, item.ordinal LIMIT ?`).bind(record.limit).all<{
			batch_id: string; source_intake_id: string; story_id: string; workflow_state: EditorialWorkflowState;
			image_evidence: 'APPROVED' | 'LEGACY_MISSING_APPROVED_IMAGE';
		}>();
		let changed = 0;
		for (const row of rows.results) {
			const auditId = record.createAuditId();
			const eventId = record.createEventId();
			const detail = `STATE_ONLY;prior=${row.workflow_state};image_evidence=${row.image_evidence}`;
			const results = await this.db.batch([
				this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'PUBLISHED', story_id = ?,
					failure_stage = NULL, failure_classification = NULL, lease_owner = NULL,
					lease_acquired_at = NULL, lease_expires_at = NULL, updated_at = ?
					WHERE batch_id = ? AND source_intake_id = ?
					AND workflow_state IN ('SELECTED', 'GENERATING', 'READY_FOR_REVIEW', 'FAILED')
					AND EXISTS (SELECT 1 FROM stories WHERE id = ? AND status = 'PUBLISHED')`)
					.bind(row.story_id, record.at, row.batch_id, row.source_intake_id, row.story_id),
				this.db.prepare(`INSERT INTO editorial_audit_log
					(id, actor_email, entity_type, entity_id, action, from_status, to_status, reason, created_at)
					SELECT ?, ?, 'STORY', ?, 'WORKFLOW_RECONCILED', ?, 'PUBLISHED', ?, ? WHERE changes() > 0`)
					.bind(auditId, record.actorEmail, row.story_id, row.workflow_state, detail, record.at),
				this.db.prepare(`INSERT INTO editorial_workflow_events
					(id, batch_id, source_intake_id, story_id, event_kind, detail, created_at)
					SELECT ?, ?, ?, ?, 'WORKFLOW_PUBLISHED_RECONCILED', ?, ?
					WHERE EXISTS (SELECT 1 FROM editorial_audit_log WHERE id = ?)`)
					.bind(eventId, row.batch_id, row.source_intake_id, row.story_id, detail, record.at, auditId),
			]);
			changed += Number(results.every((result) => result.meta.changes === 1));
		}
		return changed;
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

	async attachCandidate(batchId: string, intakeId: string, candidateId: string, owner: string, at: string): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE editorial_batch_items SET candidate_id = ?, updated_at = ?
			WHERE batch_id = ? AND source_intake_id = ? AND workflow_state = 'GENERATING'
			AND lease_owner = ? AND lease_expires_at > ? AND candidate_id IS NULL`)
			.bind(candidateId, at, batchId, intakeId, owner, at).run();
		return result.meta.changes === 1;
	}

	async findGeneratedCandidateId(intakeId: string, modelRunId: string): Promise<string | null> {
		const row = await this.db.prepare(`SELECT id FROM satire_candidates
			WHERE source_intake_id = ? AND origin_model_run_id = ? ORDER BY generation_ordinal LIMIT 1`)
			.bind(intakeId, modelRunId).first<{ id: string }>();
		return row?.id ?? null;
	}

	async findStoryIdByCandidate(candidateId: string): Promise<string | null> {
		const row = await this.db.prepare('SELECT id FROM stories WHERE origin_candidate_id = ?')
			.bind(candidateId).first<{ id: string }>();
		return row?.id ?? null;
	}

	async attachExistingStory(record: { batchId: string; intakeId: string; candidateId: string; storyId: string; owner: string; at: string; eventId: string }): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`UPDATE editorial_batch_items SET story_id = ?, updated_at = ?
				WHERE batch_id = ? AND source_intake_id = ? AND candidate_id = ? AND workflow_state = 'GENERATING'
				AND lease_owner = ? AND lease_expires_at > ?
				AND EXISTS (SELECT 1 FROM stories WHERE id = ? AND origin_candidate_id = ?
					AND status IN ('REVIEW', 'APPROVED', 'PUBLISHED'))`)
				.bind(record.storyId, record.at, record.batchId, record.intakeId, record.candidateId,
					record.owner, record.at, record.storyId, record.candidateId),
			this.event(record.eventId, record.batchId, record.intakeId, record.storyId,
				'EXISTING_STORY_ATTACHED', null, record.at),
		]);
		return results[0].meta.changes === 1;
	}

	async ensureReviewStory(record: { batchId: string; intakeId: string; candidateId: string; storyId: string; slug: string; editionDate: string; socialExcerpt: string; actorEmail: string; owner: string; at: string; eventId: string }): Promise<string | null> {
		const existing = await this.db.prepare('SELECT id FROM stories WHERE origin_candidate_id = ?')
			.bind(record.candidateId).first<{ id: string }>();
		const storyId = existing?.id ?? record.storyId;
		const results = await this.db.batch([
			this.db.prepare(`INSERT INTO stories (
				id, slug, headline, deck, body_markdown, edition_date, category_id, status,
				social_excerpt, tags_json, created_at, updated_at, origin_candidate_id
			) SELECT ?, ?, proposed_headline, proposed_deck, draft_body_markdown, ?, category_id,
				'REVIEW', ?, '[]', ?, ?, id FROM satire_candidates
				WHERE id = ? AND source_intake_id = ? AND status = 'DRAFT'
				AND body_generation_state = 'SUCCEEDED' AND trim(draft_body_markdown) <> ''
				AND EXISTS (SELECT 1 FROM editorial_batch_items AS item WHERE item.batch_id = ?
					AND item.source_intake_id = ? AND item.candidate_id = satire_candidates.id
					AND item.workflow_state = 'GENERATING' AND item.lease_owner = ? AND item.lease_expires_at > ?)
				AND NOT EXISTS (SELECT 1 FROM stories WHERE origin_candidate_id = satire_candidates.id)`)
				.bind(storyId, record.slug, record.editionDate, record.socialExcerpt,
					record.at, record.at, record.candidateId, record.intakeId,
					record.batchId, record.intakeId, record.owner, record.at),
			this.db.prepare(`INSERT OR IGNORE INTO sources (id, story_id, title, url, publisher, published_at, created_at)
				SELECT ? || ':' || reference.id, ?, reference.source_title, reference.source_url,
				reference.publisher_name, reference.published_at, ? FROM source_references AS reference
				WHERE reference.source_intake_id = ? AND EXISTS (SELECT 1 FROM stories WHERE id = ?)`)
				.bind(record.candidateId, storyId, record.at, record.intakeId, storyId),
			this.db.prepare(`UPDATE editorial_batch_items SET story_id = ?, updated_at = ?
				WHERE batch_id = ? AND source_intake_id = ? AND candidate_id = ?
				AND workflow_state = 'GENERATING' AND lease_owner = ? AND lease_expires_at > ?
				AND EXISTS (SELECT 1 FROM stories WHERE id = ? AND status IN ('REVIEW', 'APPROVED', 'PUBLISHED'))`)
				.bind(storyId, record.at, record.batchId, record.intakeId, record.candidateId,
					record.owner, record.at, storyId),
			existing ? this.db.prepare('SELECT 1 WHERE 0') : this.db.prepare(`INSERT INTO editorial_audit_log
				(id, actor_email, entity_type, entity_id, action, from_status, to_status, created_at)
				SELECT ?, ?, 'STORY', ?, 'CREATED_FOR_FINAL_REVIEW', 'DRAFT', 'REVIEW', ?
				WHERE EXISTS (SELECT 1 FROM stories WHERE id = ? AND status = 'REVIEW')`)
				.bind(`${record.eventId}:audit`, record.actorEmail, storyId, record.at, storyId),
			this.event(record.eventId, record.batchId, record.intakeId, storyId,
				existing ? 'EXISTING_STORY_ATTACHED' : 'BODY_GENERATED', null, record.at),
		]);
		if (results[2].meta.changes === 1) return storyId;
		const racedStoryId = await this.findStoryIdByCandidate(record.candidateId);
		if (!racedStoryId) return null;
		return await this.attachExistingStory({ ...record, storyId: racedStoryId, eventId: `${record.eventId}:existing` })
			? racedStoryId : null;
	}

	async markReady(batchId: string, intakeId: string, storyId: string, owner: string, at: string, eventId: string, allowMissingImage = false): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'READY_FOR_REVIEW', updated_at = ?,
				lease_owner = NULL, lease_acquired_at = NULL, lease_expires_at = NULL
				WHERE batch_id = ? AND source_intake_id = ? AND story_id = ? AND workflow_state = 'GENERATING'
				AND lease_owner = ? AND lease_expires_at > ?
				AND ((? = 1 AND batch_id = ? AND source_intake_id = ?)
					OR EXISTS (SELECT 1 FROM article_images WHERE story_id = ? AND status IN ('GENERATED', 'APPROVED')))`)
				.bind(at, batchId, intakeId, storyId, owner, at, allowMissingImage ? 1 : 0,
					SMOKE_BATCH_ID, SMOKE_INTAKE_ID, storyId),
			this.event(eventId, batchId, intakeId, storyId, 'ARTICLE_READY_FOR_REVIEW', null, at),
		]);
		return results[0].meta.changes === 1;
	}

	async markFailed(batchId: string, intakeId: string, owner: string, stage: string, classification: string, at: string, eventId: string): Promise<void> {
		await this.db.batch([
			this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'FAILED', failure_stage = ?,
				failure_classification = ?, lease_owner = NULL, lease_acquired_at = NULL,
				lease_expires_at = NULL, updated_at = ? WHERE batch_id = ? AND source_intake_id = ?
				AND workflow_state = 'GENERATING' AND lease_owner = ? AND lease_expires_at > ?`)
				.bind(stage, classification, at, batchId, intakeId, owner, at),
			this.event(eventId, batchId, intakeId, null, 'GENERATION_FAILED', `${stage}:${classification}`, at),
		]);
	}

	async releaseLease(batchId: string, intakeId: string, owner: string, at: string): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE editorial_batch_items SET lease_owner = NULL,
			lease_acquired_at = NULL, lease_expires_at = NULL, updated_at = ?
			WHERE batch_id = ? AND source_intake_id = ? AND workflow_state = 'GENERATING'
			AND lease_owner = ? AND lease_expires_at > ?`)
			.bind(at, batchId, intakeId, owner, at).run();
		return result.meta.changes === 1;
	}

	async retryFailed(batchId: string, intakeId: string, actorEmail: string, at: string, eventId: string): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'SELECTED',
				failure_stage = NULL, failure_classification = NULL, retry_attempt = retry_attempt + 1,
				retry_requested_by_email = ?, retry_requested_at = ?, updated_at = ?
				WHERE batch_id = ? AND source_intake_id = ? AND workflow_state = 'FAILED'`)
				.bind(actorEmail, at, at, batchId, intakeId),
			this.db.prepare(`INSERT OR IGNORE INTO editorial_workflow_events
				(id, batch_id, source_intake_id, event_kind, detail, created_at)
				SELECT ?, ?, ?, 'GENERATION_RETRY_REQUESTED',
					? || ';attempt=' || retry_attempt || ';key=workflow-retry:v1:' || batch_id || ':' || source_intake_id || ':' || retry_attempt, ?
				FROM editorial_batch_items WHERE batch_id = ? AND source_intake_id = ? AND changes() > 0`)
				.bind(eventId, batchId, intakeId, actorEmail, at, batchId, intakeId),
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
				WHERE id = ? AND ${PUBLISHABLE_STORY_PREDICATE}`)
				.bind(record.at, record.at, record.storyId),
			this.db.prepare(`UPDATE editorial_batch_items SET workflow_state = 'PUBLISHED', updated_at = ?
				WHERE batch_id = ? AND source_intake_id = ? AND story_id = ?
				AND workflow_state = 'READY_FOR_REVIEW' AND EXISTS
				(SELECT 1 FROM stories WHERE id = ? AND status = 'PUBLISHED' AND published_at = ?)`)
				.bind(record.at, record.batchId, record.intakeId, record.storyId, record.storyId, record.at),
			this.db.prepare(`INSERT INTO editorial_audit_log
				(id, actor_email, entity_type, entity_id, action, from_status, to_status, created_at)
				SELECT ?, ?, 'STORY', ?, 'PUBLISHED', 'APPROVED', 'PUBLISHED', ? WHERE changes() > 0
				AND EXISTS (SELECT 1 FROM stories WHERE id = ? AND status = 'PUBLISHED' AND published_at = ?)`)
				.bind(record.auditId, record.actorEmail, record.storyId, record.at, record.storyId, record.at),
			this.db.prepare(`INSERT INTO editorial_workflow_events
				(id, batch_id, source_intake_id, story_id, event_kind, detail, created_at)
				SELECT ?, ?, ?, ?, 'ARTICLE_PUBLISHED', NULL, ?
				WHERE EXISTS (SELECT 1 FROM editorial_audit_log WHERE id = ?)`)
				.bind(record.eventId, record.batchId, record.intakeId, record.storyId, record.at, record.auditId),
		]);
		return results.every((result) => result.meta.changes === 1);
	}

	async findPublicationReadiness(storyId: string): Promise<PublicationReadiness> {
		const row = await this.db.prepare(PUBLICATION_READINESS_SQL).bind(storyId)
			.first<{ readiness: PublicationReadiness }>();
		return row?.readiness ?? 'NOT_FOUND';
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
