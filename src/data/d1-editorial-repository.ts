import type {
	AuditEntry,
	CandidateStatus,
	EditorialDashboardCounts,
	EditorialStory,
	SatireCandidate,
	SatireSuitability,
	SourceIntake,
	SourceReference,
	SourceTier,
	SourceType,
} from '../domain/editorial';
import type { PublicationStatus } from '../domain/publication-status';
import type { StoryCategory } from '../domain/story';
import type {
	AddSourceReferenceRecord,
	ConvertCandidateRecord,
	CreateCandidateRecord,
	CreateIntakeRecord,
	EditorialRepository,
	PublishApprovedStoryRecord,
	TransitionCandidateRecord,
	TransitionStoryRecord,
	UpdateCandidateRecord,
	UpdateIntakeRecord,
	UpdateSourceReferenceRecord,
	UpdateStoryRecord,
} from './editorial-repository';

interface IntakeRow {
	id: string;
	title: string;
	neutral_brief: string;
	significance_score: number;
	satire_potential_score: number;
	satire_suitability: SatireSuitability;
	editorial_notes: string;
	suitability_reason: string;
	guardrail_flags_json: string;
	assessment_reviewed_by_email: string | null;
	assessment_reviewed_at: string | null;
	accepted_model_run_id: string | null;
	created_by_email: string;
	updated_by_email: string;
	created_at: string;
	updated_at: string;
}

interface ReferenceRow {
	id: string;
	source_intake_id: string;
	source_title: string;
	source_url: string;
	publisher_name: string;
	source_tier: SourceTier;
	source_type: SourceType;
	published_at: string | null;
	created_at: string;
	updated_at: string;
}

interface CandidateRow {
	id: string;
	source_intake_id: string;
	source_intake_title: string;
	proposed_headline: string;
	proposed_deck: string;
	draft_body_markdown: string;
	category_id: string;
	category_slug: string;
	category_name: string;
	editorial_notes: string;
	status: CandidateStatus;
	created_by_email: string;
	updated_by_email: string;
	created_at: string;
	updated_at: string;
	converted_story_id: string | null;
	origin_model_run_id: string | null;
	normalized_event_version_id: string | null;
	generation_ordinal: number | null;
	rationale: string;
	satirical_mechanism: string;
	origin_kind: 'MANUAL' | 'MODEL';
	body_generation_state: 'NOT_REQUESTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED';
	body_generation_run_id: string | null;
}

interface EditorialStoryRow {
	id: string;
	slug: string;
	headline: string;
	deck: string;
	body_markdown: string;
	edition_date: string;
	published_at: string | null;
	category_id: string;
	category_slug: string;
	category_name: string;
	status: PublicationStatus;
	social_excerpt: string;
	og_image_key: string | null;
	tags_json: string;
	origin_candidate_id: string | null;
	updated_at: string;
}

interface AuditRow {
	id: string;
	actor_email: string;
	entity_type: AuditEntry['entityType'];
	entity_id: string;
	action: string;
	from_status: string | null;
	to_status: string | null;
	reason: string | null;
	created_at: string;
}

const CANDIDATE_SELECT = `
	SELECT
		candidate.id,
		candidate.source_intake_id,
		intake.title AS source_intake_title,
		candidate.proposed_headline,
		candidate.proposed_deck,
		candidate.draft_body_markdown,
		candidate.category_id,
		category.slug AS category_slug,
		category.name AS category_name,
		candidate.editorial_notes,
		candidate.status,
		candidate.created_by_email,
		candidate.updated_by_email,
		candidate.created_at,
		candidate.updated_at,
		story.id AS converted_story_id,
		candidate.origin_model_run_id,
		candidate.normalized_event_version_id,
		candidate.generation_ordinal,
		candidate.rationale,
		candidate.satirical_mechanism,
		candidate.origin_kind,
		candidate.body_generation_state,
		candidate.body_generation_run_id
	FROM satire_candidates AS candidate
	JOIN source_intakes AS intake ON intake.id = candidate.source_intake_id
	JOIN categories AS category ON category.id = candidate.category_id
	LEFT JOIN stories AS story ON story.origin_candidate_id = candidate.id
`;

const EDITORIAL_STORY_SELECT = `
	SELECT
		story.id,
		story.slug,
		story.headline,
		story.deck,
		story.body_markdown,
		story.edition_date,
		story.published_at,
		story.category_id,
		category.slug AS category_slug,
		category.name AS category_name,
		story.status,
		story.social_excerpt,
		story.og_image_key,
		story.tags_json,
		story.origin_candidate_id,
		story.updated_at
	FROM stories AS story
	JOIN categories AS category ON category.id = story.category_id
`;

function clampLimit(limit: number): number {
	return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function mapReference(row: ReferenceRow): SourceReference {
	return {
		id: row.id,
		sourceIntakeId: row.source_intake_id,
		sourceTitle: row.source_title,
		sourceUrl: row.source_url,
		publisherName: row.publisher_name,
		sourceTier: row.source_tier,
		sourceType: row.source_type,
		publishedAt: row.published_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapIntake(row: IntakeRow, references: SourceReference[] = []): SourceIntake {
	let guardrailFlags: SourceIntake['guardrailFlags'] = [];
	try {
		const parsed: unknown = JSON.parse(row.guardrail_flags_json);
		if (Array.isArray(parsed)) guardrailFlags = parsed as SourceIntake['guardrailFlags'];
	} catch {
		// Invalid legacy JSON is displayed empty and corrected on normalization acceptance.
	}
	return {
		id: row.id,
		title: row.title,
		neutralBrief: row.neutral_brief,
		significanceScore: row.significance_score,
		satirePotentialScore: row.satire_potential_score,
		satireSuitability: row.satire_suitability,
		editorialNotes: row.editorial_notes,
		suitabilityReason: row.suitability_reason,
		guardrailFlags,
		assessmentReviewedByEmail: row.assessment_reviewed_by_email,
		assessmentReviewedAt: row.assessment_reviewed_at,
		acceptedModelRunId: row.accepted_model_run_id,
		createdByEmail: row.created_by_email,
		updatedByEmail: row.updated_by_email,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		references,
	};
}

function mapCandidate(row: CandidateRow): SatireCandidate {
	return {
		id: row.id,
		sourceIntakeId: row.source_intake_id,
		sourceIntakeTitle: row.source_intake_title,
		proposedHeadline: row.proposed_headline,
		proposedDeck: row.proposed_deck,
		draftBodyMarkdown: row.draft_body_markdown,
		category: {
			id: row.category_id,
			slug: row.category_slug,
			name: row.category_name,
		},
		editorialNotes: row.editorial_notes,
		status: row.status,
		createdByEmail: row.created_by_email,
		updatedByEmail: row.updated_by_email,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		convertedStoryId: row.converted_story_id,
		originModelRunId: row.origin_model_run_id,
		normalizedEventVersionId: row.normalized_event_version_id,
		generationOrdinal: row.generation_ordinal,
		rationale: row.rationale,
		satiricalMechanism: row.satirical_mechanism,
		originKind: row.origin_kind,
		bodyGenerationState: row.body_generation_state,
		bodyGenerationRunId: row.body_generation_run_id,
	};
}

function mapEditorialStory(row: EditorialStoryRow): EditorialStory {
	let tags: string[] = [];
	try {
		const parsed: unknown = JSON.parse(row.tags_json);
		if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string')) tags = parsed;
	} catch {
		// Invalid legacy JSON is displayed as an empty tag list and corrected on the next save.
	}

	return {
		id: row.id,
		slug: row.slug,
		headline: row.headline,
		deck: row.deck,
		bodyMarkdown: row.body_markdown,
		editionDate: row.edition_date,
		publishedAt: row.published_at,
		category: {
			id: row.category_id,
			slug: row.category_slug,
			name: row.category_name,
		},
		status: row.status,
		socialExcerpt: row.social_excerpt,
		ogImageKey: row.og_image_key,
		tags,
		originCandidateId: row.origin_candidate_id,
		updatedAt: row.updated_at,
	};
}

function mapAudit(row: AuditRow): AuditEntry {
	return {
		id: row.id,
		actorEmail: row.actor_email,
		entityType: row.entity_type,
		entityId: row.entity_id,
		action: row.action,
		fromStatus: row.from_status,
		toStatus: row.to_status,
		reason: row.reason,
		createdAt: row.created_at,
	};
}

export class D1EditorialRepository implements EditorialRepository {
	constructor(private readonly db: D1Database) {}

	async getDashboardCounts(): Promise<EditorialDashboardCounts> {
		const row = await this.db
			.prepare(`
				SELECT
					(SELECT COUNT(*) FROM source_intakes) AS intakes,
					(SELECT COUNT(*) FROM satire_candidates WHERE status = 'REVIEW') AS candidates_in_review,
					(SELECT COUNT(*) FROM satire_candidates AS candidate
						WHERE candidate.status = 'APPROVED'
						AND NOT EXISTS (
							SELECT 1 FROM stories WHERE origin_candidate_id = candidate.id
						)) AS approved_candidates,
					(SELECT COUNT(*) FROM stories WHERE status = 'APPROVED') AS stories_awaiting_publication
			`)
			.first<{
				intakes: number;
				candidates_in_review: number;
				approved_candidates: number;
				stories_awaiting_publication: number;
			}>();

		return {
			intakes: row?.intakes ?? 0,
			candidatesInReview: row?.candidates_in_review ?? 0,
			approvedCandidates: row?.approved_candidates ?? 0,
			storiesAwaitingPublication: row?.stories_awaiting_publication ?? 0,
		};
	}

	async listCategories(): Promise<StoryCategory[]> {
		const result = await this.db
			.prepare('SELECT id, slug, name FROM categories ORDER BY name ASC')
			.all<StoryCategory>();
		return result.results;
	}

	async categoryExists(id: string): Promise<boolean> {
		return Boolean(
			await this.db.prepare('SELECT 1 AS found FROM categories WHERE id = ? LIMIT 1').bind(id).first(),
		);
	}

	async listIntakes(limit = 50): Promise<SourceIntake[]> {
		const result = await this.db
			.prepare('SELECT * FROM source_intakes ORDER BY updated_at DESC LIMIT ?')
			.bind(clampLimit(limit))
			.all<IntakeRow>();
		return result.results.map((row) => mapIntake(row));
	}

	async findIntakeById(id: string): Promise<SourceIntake | null> {
		const row = await this.db
			.prepare('SELECT * FROM source_intakes WHERE id = ? LIMIT 1')
			.bind(id)
			.first<IntakeRow>();
		if (!row) return null;

		const references = await this.db
			.prepare('SELECT * FROM source_references WHERE source_intake_id = ? ORDER BY created_at ASC')
			.bind(id)
			.all<ReferenceRow>();
		return mapIntake(row, references.results.map(mapReference));
	}

	async createIntake(record: CreateIntakeRecord): Promise<void> {
		await this.db.batch([
			this.db
				.prepare(`
					INSERT INTO source_intakes (
						id, title, neutral_brief, significance_score, satire_potential_score,
						satire_suitability, editorial_notes, created_by_email, updated_by_email,
						created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.bind(
					record.intakeId,
					record.title,
					record.neutralBrief,
					record.significanceScore,
					record.satirePotentialScore,
					record.satireSuitability,
					record.editorialNotes,
					record.actorEmail,
					record.actorEmail,
					record.createdAt,
					record.createdAt,
				),
			this.db
				.prepare(`
					INSERT INTO source_references (
						id, source_intake_id, source_title, source_url, publisher_name,
						source_tier, source_type, published_at, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.bind(
					record.referenceId,
					record.intakeId,
					record.sourceTitle,
					record.sourceUrl,
					record.publisherName,
					record.sourceTier,
					record.sourceType,
					record.publishedAt,
					record.createdAt,
					record.createdAt,
				),
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log
						(id, actor_email, entity_type, entity_id, action, created_at)
					VALUES (?, ?, 'SOURCE_INTAKE', ?, 'CREATED', ?)
				`)
				.bind(record.auditIds[0], record.actorEmail, record.intakeId, record.createdAt),
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log
						(id, actor_email, entity_type, entity_id, action, created_at)
					VALUES (?, ?, 'SOURCE_REFERENCE', ?, 'CREATED', ?)
				`)
				.bind(record.auditIds[1], record.actorEmail, record.referenceId, record.createdAt),
		]);
	}

	async updateIntake(record: UpdateIntakeRecord): Promise<boolean> {
		const results = await this.db.batch([
			this.db
				.prepare(`
					UPDATE source_intakes SET
						title = ?, neutral_brief = ?, significance_score = ?,
						satire_potential_score = ?, satire_suitability = ?, editorial_notes = ?,
						updated_by_email = ?, updated_at = ?
					WHERE id = ?
				`)
				.bind(
					record.title,
					record.neutralBrief,
					record.significanceScore,
					record.satirePotentialScore,
					record.satireSuitability,
					record.editorialNotes,
					record.actorEmail,
					record.updatedAt,
					record.id,
				),
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log
						(id, actor_email, entity_type, entity_id, action, created_at)
					SELECT ?, ?, 'SOURCE_INTAKE', ?, 'UPDATED', ?
					WHERE EXISTS (SELECT 1 FROM source_intakes WHERE id = ? AND updated_at = ?)
				`)
				.bind(
					record.auditId,
					record.actorEmail,
					record.id,
					record.updatedAt,
					record.id,
					record.updatedAt,
				),
		]);
		return results[0].meta.changes === 1;
	}

	async addSourceReference(record: AddSourceReferenceRecord): Promise<boolean> {
		const results = await this.db.batch([
			this.db
				.prepare(`
					INSERT INTO source_references (
						id, source_intake_id, source_title, source_url, publisher_name,
						source_tier, source_type, published_at, created_at, updated_at
					)
					SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					WHERE EXISTS (SELECT 1 FROM source_intakes WHERE id = ?)
				`)
				.bind(
					record.id,
					record.sourceIntakeId,
					record.sourceTitle,
					record.sourceUrl,
					record.publisherName,
					record.sourceTier,
					record.sourceType,
					record.publishedAt,
					record.createdAt,
					record.createdAt,
					record.sourceIntakeId,
				),
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log
						(id, actor_email, entity_type, entity_id, action, created_at)
					SELECT ?, ?, 'SOURCE_REFERENCE', ?, 'CREATED', ?
					WHERE EXISTS (SELECT 1 FROM source_references WHERE id = ?)
				`)
				.bind(record.auditId, record.actorEmail, record.id, record.createdAt, record.id),
		]);
		return results[0].meta.changes === 1;
	}

	async updateSourceReference(record: UpdateSourceReferenceRecord): Promise<boolean> {
		const results = await this.db.batch([
			this.db
				.prepare(`
					UPDATE source_references SET
						source_title = ?, source_url = ?, publisher_name = ?, source_tier = ?,
						source_type = ?, published_at = ?, updated_at = ?
					WHERE id = ?
				`)
				.bind(
					record.sourceTitle,
					record.sourceUrl,
					record.publisherName,
					record.sourceTier,
					record.sourceType,
					record.publishedAt,
					record.updatedAt,
					record.id,
				),
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log
						(id, actor_email, entity_type, entity_id, action, created_at)
					SELECT ?, ?, 'SOURCE_REFERENCE', ?, 'UPDATED', ?
					WHERE EXISTS (SELECT 1 FROM source_references WHERE id = ? AND updated_at = ?)
				`)
				.bind(
					record.auditId,
					record.actorEmail,
					record.id,
					record.updatedAt,
					record.id,
					record.updatedAt,
				),
		]);
		return results[0].meta.changes === 1;
	}

	async listCandidates(limit = 50): Promise<SatireCandidate[]> {
		const result = await this.db
			.prepare(`${CANDIDATE_SELECT} ORDER BY candidate.updated_at DESC LIMIT ?`)
			.bind(clampLimit(limit))
			.all<CandidateRow>();
		return result.results.map(mapCandidate);
	}

	async findCandidateById(id: string): Promise<SatireCandidate | null> {
		const row = await this.db
			.prepare(`${CANDIDATE_SELECT} WHERE candidate.id = ? LIMIT 1`)
			.bind(id)
			.first<CandidateRow>();
		return row ? mapCandidate(row) : null;
	}

	async createCandidate(record: CreateCandidateRecord): Promise<boolean> {
		const results = await this.db.batch([
			this.db
				.prepare(`
					INSERT INTO satire_candidates (
						id, source_intake_id, proposed_headline, proposed_deck, draft_body_markdown,
						category_id, editorial_notes, status, created_by_email, updated_by_email,
						created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)
				`)
				.bind(
					record.id,
					record.sourceIntakeId,
					record.proposedHeadline,
					record.proposedDeck,
					record.draftBodyMarkdown,
					record.categoryId,
					record.editorialNotes,
					record.actorEmail,
					record.actorEmail,
					record.createdAt,
					record.createdAt,
				),
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log
						(id, actor_email, entity_type, entity_id, action, to_status, created_at)
					VALUES (?, ?, 'SATIRE_CANDIDATE', ?, 'CREATED', 'DRAFT', ?)
				`)
				.bind(record.auditId, record.actorEmail, record.id, record.createdAt),
		]);
		return results[0].meta.changes === 1;
	}

	async updateCandidate(record: UpdateCandidateRecord): Promise<boolean> {
		const results = await this.db.batch([
			this.db
				.prepare(`
					UPDATE satire_candidates SET
						proposed_headline = ?, proposed_deck = ?, draft_body_markdown = ?,
						category_id = ?, editorial_notes = ?, updated_by_email = ?, updated_at = ?
					WHERE id = ?
					AND NOT EXISTS (SELECT 1 FROM stories WHERE origin_candidate_id = ?)
				`)
				.bind(
					record.proposedHeadline,
					record.proposedDeck,
					record.draftBodyMarkdown,
					record.categoryId,
					record.editorialNotes,
					record.actorEmail,
					record.updatedAt,
					record.id,
					record.id,
				),
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log
						(id, actor_email, entity_type, entity_id, action, created_at)
					SELECT ?, ?, 'SATIRE_CANDIDATE', ?, 'UPDATED', ?
					WHERE EXISTS (SELECT 1 FROM satire_candidates WHERE id = ? AND updated_at = ?)
				`)
				.bind(
					record.auditId,
					record.actorEmail,
					record.id,
					record.updatedAt,
					record.id,
					record.updatedAt,
				),
		]);
		return results[0].meta.changes === 1;
	}

	async transitionCandidate(record: TransitionCandidateRecord): Promise<boolean> {
		const results = await this.db.batch([
			this.db
				.prepare(`
					UPDATE satire_candidates
					SET status = ?, updated_by_email = ?, updated_at = ?
					WHERE id = ? AND status = ?
					AND NOT EXISTS (SELECT 1 FROM stories WHERE origin_candidate_id = ?)
				`)
				.bind(
					record.to,
					record.actorEmail,
					record.updatedAt,
					record.id,
					record.from,
					record.id,
				),
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log (
						id, actor_email, entity_type, entity_id, action,
						from_status, to_status, created_at
					)
					SELECT ?, ?, 'SATIRE_CANDIDATE', ?, 'STATUS_CHANGED', ?, ?, ?
					WHERE EXISTS (
						SELECT 1 FROM satire_candidates WHERE id = ? AND status = ? AND updated_at = ?
					)
				`)
				.bind(
					record.auditId,
					record.actorEmail,
					record.id,
					record.from,
					record.to,
					record.updatedAt,
					record.id,
					record.to,
					record.updatedAt,
				),
		]);
		return results[0].meta.changes === 1;
	}

	async convertApprovedCandidateToDraft(record: ConvertCandidateRecord): Promise<boolean> {
		const results = await this.db.batch([
			this.db
				.prepare(`
					INSERT INTO stories (
						id, slug, headline, deck, body_markdown, edition_date, published_at,
						category_id, status, social_excerpt, og_image_key, tags_json,
						created_at, updated_at, origin_candidate_id
					)
					SELECT
						?, ?, candidate.proposed_headline, candidate.proposed_deck,
						candidate.draft_body_markdown, ?, NULL, candidate.category_id,
						'DRAFT', ?, NULL, '[]', ?, ?, candidate.id
					FROM satire_candidates AS candidate
					WHERE candidate.id = ? AND candidate.status = 'APPROVED'
					AND NOT EXISTS (SELECT 1 FROM stories WHERE origin_candidate_id = candidate.id)
				`)
				.bind(
					record.storyId,
					record.slug,
					record.editionDate,
					record.socialExcerpt,
					record.createdAt,
					record.createdAt,
					record.candidateId,
				),
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log (
						id, actor_email, entity_type, entity_id, action, from_status, to_status, created_at
					)
					SELECT ?, ?, 'SATIRE_CANDIDATE', ?, 'CONVERTED_TO_STORY', 'APPROVED', 'DRAFT', ?
					WHERE EXISTS (
						SELECT 1 FROM stories WHERE id = ? AND origin_candidate_id = ? AND status = 'DRAFT'
					)
				`)
				.bind(
					record.auditIds[0],
					record.actorEmail,
					record.candidateId,
					record.createdAt,
					record.storyId,
					record.candidateId,
				),
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log (
						id, actor_email, entity_type, entity_id, action, from_status, to_status, created_at
					)
					SELECT ?, ?, 'STORY', ?, 'CREATED_FROM_CANDIDATE', 'APPROVED', 'DRAFT', ?
					WHERE EXISTS (
						SELECT 1 FROM stories WHERE id = ? AND origin_candidate_id = ? AND status = 'DRAFT'
					)
				`)
				.bind(
					record.auditIds[1],
					record.actorEmail,
					record.storyId,
					record.createdAt,
					record.storyId,
					record.candidateId,
				),
		]);
		return results[0].meta.changes === 1;
	}

	async listEditorialStories(limit = 50): Promise<EditorialStory[]> {
		const result = await this.db
			.prepare(`${EDITORIAL_STORY_SELECT} ORDER BY story.updated_at DESC LIMIT ?`)
			.bind(clampLimit(limit))
			.all<EditorialStoryRow>();
		return result.results.map(mapEditorialStory);
	}

	async findEditorialStoryById(id: string): Promise<EditorialStory | null> {
		const row = await this.db
			.prepare(`${EDITORIAL_STORY_SELECT} WHERE story.id = ? LIMIT 1`)
			.bind(id)
			.first<EditorialStoryRow>();
		return row ? mapEditorialStory(row) : null;
	}

	async updateStory(record: UpdateStoryRecord): Promise<boolean> {
		const results = await this.db.batch([
			this.db
				.prepare(`
					UPDATE stories SET
						slug = ?, headline = ?, deck = ?, body_markdown = ?, edition_date = ?,
						category_id = ?, social_excerpt = ?, tags_json = ?, updated_at = ?
					WHERE id = ? AND status NOT IN ('PUBLISHED', 'ARCHIVED')
				`)
				.bind(
					record.slug,
					record.headline,
					record.deck,
					record.bodyMarkdown,
					record.editionDate,
					record.categoryId,
					record.socialExcerpt,
					JSON.stringify(record.tags),
					record.updatedAt,
					record.id,
				),
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log
						(id, actor_email, entity_type, entity_id, action, created_at)
					SELECT ?, ?, 'STORY', ?, 'UPDATED', ?
					WHERE EXISTS (SELECT 1 FROM stories WHERE id = ? AND updated_at = ?)
				`)
				.bind(
					record.auditId,
					record.actorEmail,
					record.id,
					record.updatedAt,
					record.id,
					record.updatedAt,
				),
		]);
		return results[0].meta.changes === 1;
	}

	async transitionStory(record: TransitionStoryRecord): Promise<boolean> {
		const results = await this.db.batch([
			this.db
				.prepare(`
					UPDATE stories SET status = ?, updated_at = ?
					WHERE id = ? AND status = ? AND ? <> 'PUBLISHED'
				`)
				.bind(record.to, record.updatedAt, record.id, record.from, record.to),
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log (
						id, actor_email, entity_type, entity_id, action,
						from_status, to_status, created_at
					)
					SELECT ?, ?, 'STORY', ?, 'STATUS_CHANGED', ?, ?, ?
					WHERE EXISTS (SELECT 1 FROM stories WHERE id = ? AND status = ? AND updated_at = ?)
				`)
				.bind(
					record.auditId,
					record.actorEmail,
					record.id,
					record.from,
					record.to,
					record.updatedAt,
					record.id,
					record.to,
					record.updatedAt,
				),
		]);
		return results[0].meta.changes === 1;
	}

	async publishApprovedStory(record: PublishApprovedStoryRecord): Promise<boolean> {
		const results = await this.db.batch([
			this.db
				.prepare(`
					INSERT INTO editorial_audit_log (
						id, actor_email, entity_type, entity_id, action,
						from_status, to_status, created_at
					)
					SELECT ?, ?, 'STORY', story.id, 'PUBLISHED', 'APPROVED', 'PUBLISHED', ?
					FROM stories AS story
					WHERE story.id = ? AND story.status = 'APPROVED' AND story.published_at IS NULL
				`)
				.bind(
					record.auditId,
					record.actorEmail,
					record.publishedAt,
					record.id,
				),
			this.db
				.prepare(`
					UPDATE stories
					SET status = 'PUBLISHED', published_at = ?, updated_at = ?
					WHERE id = ? AND status = 'APPROVED' AND published_at IS NULL
				`)
				.bind(record.publishedAt, record.publishedAt, record.id),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}

	async listAuditEntries(
		entityType: AuditEntry['entityType'],
		entityId: string,
	): Promise<AuditEntry[]> {
		const result = await this.db
			.prepare(`
				SELECT * FROM editorial_audit_log
				WHERE entity_type = ? AND entity_id = ?
				ORDER BY created_at DESC
			`)
			.bind(entityType, entityId)
			.all<AuditRow>();
		return result.results.map(mapAudit);
	}
}
