import type { SourceIntake, SourceReference, SatireSuitability, SourceTier, SourceType } from '../domain/editorial';
import type {
	AssertionKind,
	GuardrailFlag,
	ModelOperation,
	ModelRun,
	NormalizedEventOrigin,
	NormalizedEventReviewState,
	NormalizedEventVersion,
	SourceRelationship,
} from '../domain/generation';
import type {
	CreateEditorRevisionRecord,
	CreateGeneratedCandidatesRecord,
	CreateNormalizationRecord,
	GenerationRepository,
	ModelRunRecord,
	ReviewNormalizationRecord,
} from './generation-repository';

interface IntakeRow {
	id: string; title: string; neutral_brief: string; significance_score: number;
	satire_potential_score: number; satire_suitability: SatireSuitability; editorial_notes: string;
	suitability_reason: string; guardrail_flags_json: string; assessment_reviewed_by_email: string | null;
	assessment_reviewed_at: string | null; accepted_model_run_id: string | null;
	created_by_email: string; updated_by_email: string; created_at: string; updated_at: string;
}
interface ReferenceRow {
	id: string; source_intake_id: string; source_title: string; source_url: string;
	publisher_name: string; source_tier: SourceTier; source_type: SourceType;
	published_at: string | null; created_at: string; updated_at: string;
}
interface VersionRow {
	id: string; source_intake_id: string; parent_version_id: string | null; version_number: number;
	review_state: NormalizedEventReviewState; origin: NormalizedEventOrigin; event_statement: string;
	proposed_significance_score: number; proposed_satire_potential_score: number;
	proposed_suitability: SatireSuitability; suitability_reason: string; guardrail_flags_json: string;
	model_run_id: string | null; created_by_email: string; reviewed_by_email: string | null;
	review_reason: string | null; created_at: string; reviewed_at: string | null;
}
interface AssertionRow { id: string; assertion_kind: AssertionKind; statement: string; ordinal: number; }
interface LinkRow { assertion_id: string; source_reference_id: string; relationship: SourceRelationship; }
interface ModelRunRow {
	id: string; operation: ModelOperation; status: 'SUCCEEDED' | 'FAILED'; source_intake_id: string;
	normalized_event_version_id: string | null; provider: string; model: string; provider_revision: string | null;
	prompt_version: string; input_hash: string; output_hash: string | null; input_tokens: number | null;
	output_tokens: number | null; input_characters: number; output_characters: number; latency_ms: number;
	retry_count: number; estimated_cost_microusd: number; candidate_count: number; idempotency_key: string;
	requested_by_email: string; failure_classification: string | null; created_at: string; completed_at: string;
}

function jsonFlags(value: string): GuardrailFlag[] {
	try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed as GuardrailFlag[] : []; }
	catch { return []; }
}

function mapReference(row: ReferenceRow): SourceReference {
	return { id: row.id, sourceIntakeId: row.source_intake_id, sourceTitle: row.source_title,
		sourceUrl: row.source_url, publisherName: row.publisher_name, sourceTier: row.source_tier,
		sourceType: row.source_type, publishedAt: row.published_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapIntake(row: IntakeRow, references: SourceReference[]): SourceIntake {
	return { id: row.id, title: row.title, neutralBrief: row.neutral_brief,
		significanceScore: row.significance_score, satirePotentialScore: row.satire_potential_score,
		satireSuitability: row.satire_suitability, editorialNotes: row.editorial_notes,
		suitabilityReason: row.suitability_reason, guardrailFlags: jsonFlags(row.guardrail_flags_json),
		assessmentReviewedByEmail: row.assessment_reviewed_by_email,
		assessmentReviewedAt: row.assessment_reviewed_at, acceptedModelRunId: row.accepted_model_run_id,
		createdByEmail: row.created_by_email, updatedByEmail: row.updated_by_email,
		createdAt: row.created_at, updatedAt: row.updated_at, references };
}

function mapRun(row: ModelRunRow): ModelRun {
	return { id: row.id, operation: row.operation, status: row.status, sourceIntakeId: row.source_intake_id,
		normalizedEventVersionId: row.normalized_event_version_id, provider: row.provider, model: row.model,
		providerRevision: row.provider_revision, promptVersion: row.prompt_version, inputHash: row.input_hash,
		outputHash: row.output_hash, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
		inputCharacters: row.input_characters, outputCharacters: row.output_characters, latencyMs: row.latency_ms,
		retryCount: row.retry_count, estimatedCostMicrousd: row.estimated_cost_microusd,
		candidateCount: row.candidate_count, idempotencyKey: row.idempotency_key,
		requestedByEmail: row.requested_by_email, failureClassification: row.failure_classification,
		createdAt: row.created_at, completedAt: row.completed_at };
}

function insertRun(db: D1Database, run: ModelRunRecord): D1PreparedStatement {
	return db.prepare(`INSERT INTO model_runs (
		id, operation, status, source_intake_id, normalized_event_version_id, provider, model,
		provider_revision, prompt_version, input_hash, output_hash,
		input_tokens, output_tokens, input_characters, output_characters, latency_ms, retry_count,
		estimated_cost_microusd, candidate_count, idempotency_key, requested_by_email,
		failure_classification, created_at, completed_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.bind(run.id, run.operation, run.status, run.sourceIntakeId, run.normalizedEventVersionId,
			run.provider, run.model, run.providerRevision, run.promptVersion, run.inputHash, run.outputHash,
			run.inputTokens, run.outputTokens, run.inputCharacters,
			run.outputCharacters, run.latencyMs, run.retryCount, run.estimatedCostMicrousd,
			run.candidateCount, run.idempotencyKey, run.requestedByEmail, run.failureClassification,
			run.createdAt, run.completedAt);
}

export class D1GenerationRepository implements GenerationRepository {
	constructor(private readonly db: D1Database) {}

	async findIntakeForGeneration(id: string): Promise<SourceIntake | null> {
		const row = await this.db.prepare('SELECT * FROM source_intakes WHERE id = ? LIMIT 1').bind(id).first<IntakeRow>();
		if (!row) return null;
		const references = await this.db.prepare('SELECT * FROM source_references WHERE source_intake_id = ? ORDER BY created_at').bind(id).all<ReferenceRow>();
		return mapIntake(row, references.results.map(mapReference));
	}

	async getNextNormalizedVersionNumber(intakeId: string): Promise<number> {
		const row = await this.db.prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM normalized_event_versions WHERE source_intake_id = ?').bind(intakeId).first<{ next: number }>();
		return row?.next ?? 1;
	}

	async listNormalizedVersions(intakeId: string): Promise<NormalizedEventVersion[]> {
		const rows = await this.db.prepare('SELECT * FROM normalized_event_versions WHERE source_intake_id = ? ORDER BY version_number DESC').bind(intakeId).all<VersionRow>();
		return Promise.all(rows.results.map((row) => this.mapVersion(row)));
	}

	async findNormalizedVersion(id: string): Promise<NormalizedEventVersion | null> {
		const row = await this.db.prepare('SELECT * FROM normalized_event_versions WHERE id = ? LIMIT 1').bind(id).first<VersionRow>();
		return row ? this.mapVersion(row) : null;
	}

	async findAcceptedNormalizedVersion(intakeId: string): Promise<NormalizedEventVersion | null> {
		const row = await this.db.prepare("SELECT * FROM normalized_event_versions WHERE source_intake_id = ? AND review_state = 'ACCEPTED' LIMIT 1").bind(intakeId).first<VersionRow>();
		return row ? this.mapVersion(row) : null;
	}

	private async mapVersion(row: VersionRow): Promise<NormalizedEventVersion> {
		const assertions = await this.db.prepare('SELECT id, assertion_kind, statement, ordinal FROM normalized_event_assertions WHERE normalized_event_version_id = ? ORDER BY ordinal').bind(row.id).all<AssertionRow>();
		const links = await this.db.prepare(`SELECT link.assertion_id, link.source_reference_id, link.relationship
			FROM normalized_assertion_sources AS link
			JOIN normalized_event_assertions AS assertion ON assertion.id = link.assertion_id
			WHERE assertion.normalized_event_version_id = ?`).bind(row.id).all<LinkRow>();
		return { id: row.id, sourceIntakeId: row.source_intake_id, parentVersionId: row.parent_version_id,
			versionNumber: row.version_number, reviewState: row.review_state, origin: row.origin,
			eventStatement: row.event_statement, assertions: assertions.results.map((assertion) => ({
				id: assertion.id, kind: assertion.assertion_kind, statement: assertion.statement,
				sources: links.results.filter((link) => link.assertion_id === assertion.id).map((link) => ({ sourceReferenceId: link.source_reference_id, relationship: link.relationship })),
			})), proposedSignificanceScore: row.proposed_significance_score,
			proposedSatirePotentialScore: row.proposed_satire_potential_score,
			proposedSuitability: row.proposed_suitability, suitabilityReason: row.suitability_reason,
			guardrailFlags: jsonFlags(row.guardrail_flags_json), modelRunId: row.model_run_id,
			createdByEmail: row.created_by_email, reviewedByEmail: row.reviewed_by_email,
			reviewReason: row.review_reason, createdAt: row.created_at, reviewedAt: row.reviewed_at };
	}

	async findModelRun(id: string): Promise<ModelRun | null> {
		const row = await this.db.prepare('SELECT * FROM model_runs WHERE id = ? LIMIT 1').bind(id).first<ModelRunRow>();
		return row ? mapRun(row) : null;
	}

	async findModelRunByIdempotencyKey(key: string): Promise<ModelRun | null> {
		const row = await this.db.prepare('SELECT * FROM model_runs WHERE idempotency_key = ? LIMIT 1').bind(key).first<ModelRunRow>();
		return row ? mapRun(row) : null;
	}

	async createModelRun(run: ModelRunRecord): Promise<void> {
		await insertRun(this.db, run).run();
	}

	async sumModelRunCostSince(createdAt: string): Promise<number> {
		const row = await this.db.prepare('SELECT COALESCE(SUM(estimated_cost_microusd), 0) AS cost FROM model_runs WHERE created_at >= ?').bind(createdAt).first<{ cost: number }>();
		return row?.cost ?? 0;
	}

	async countSuccessfulGenerationRuns(versionId: string): Promise<number> {
		const row = await this.db.prepare("SELECT COUNT(*) AS count FROM model_runs WHERE normalized_event_version_id = ? AND operation = 'GENERATE_CANDIDATES' AND status = 'SUCCEEDED'").bind(versionId).first<{ count: number }>();
		return row?.count ?? 0;
	}

	async categoryExists(id: string): Promise<boolean> {
		return Boolean(await this.db.prepare('SELECT 1 AS found FROM categories WHERE id = ? LIMIT 1').bind(id).first());
	}

	async createNormalization(record: CreateNormalizationRecord): Promise<void> {
		const statements: D1PreparedStatement[] = [
			insertRun(this.db, { ...record.run, normalizedEventVersionId: null }),
			this.insertVersion(record.versionId, record.run.sourceIntakeId, null, record.versionNumber, 'PROPOSED', 'MODEL', record.proposal, record.run.id, record.run.requestedByEmail, record.createdAt),
		];
		record.proposal.assertions.forEach((assertion, index) => {
			const assertionId = record.assertionIds[index];
			statements.push(this.db.prepare('INSERT INTO normalized_event_assertions (id, normalized_event_version_id, ordinal, assertion_kind, statement) VALUES (?, ?, ?, ?, ?)').bind(assertionId, record.versionId, index, assertion.kind, assertion.statement));
			assertion.sources.forEach((source) => statements.push(this.db.prepare('INSERT INTO normalized_assertion_sources (assertion_id, source_reference_id, relationship) VALUES (?, ?, ?)').bind(assertionId, source.sourceReferenceId, source.relationship)));
		});
		statements.push(this.db.prepare('UPDATE model_runs SET normalized_event_version_id = ? WHERE id = ?').bind(record.versionId, record.run.id));
		await this.db.batch(statements);
	}

	async createEditorRevision(record: CreateEditorRevisionRecord): Promise<void> {
		const statements: D1PreparedStatement[] = [this.insertVersion(record.versionId, record.parent.sourceIntakeId, record.parent.id, record.versionNumber, 'PROPOSED', 'EDITOR', record.proposal, null, record.actorEmail, record.createdAt)];
		record.proposal.assertions.forEach((assertion, index) => {
			const assertionId = record.assertionIds[index];
			statements.push(this.db.prepare('INSERT INTO normalized_event_assertions (id, normalized_event_version_id, ordinal, assertion_kind, statement) VALUES (?, ?, ?, ?, ?)').bind(assertionId, record.versionId, index, assertion.kind, assertion.statement));
			assertion.sources.forEach((source) => statements.push(this.db.prepare('INSERT INTO normalized_assertion_sources (assertion_id, source_reference_id, relationship) VALUES (?, ?, ?)').bind(assertionId, source.sourceReferenceId, source.relationship)));
		});
		statements.push(this.db.prepare("INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, reason, created_at) VALUES (?, ?, 'SOURCE_INTAKE', ?, 'NORMALIZATION_REVISED', ?, ?)").bind(record.auditId, record.actorEmail, record.parent.sourceIntakeId, record.revisionReason, record.createdAt));
		await this.db.batch(statements);
	}

	private insertVersion(id: string, intakeId: string, parentId: string | null, versionNumber: number, state: NormalizedEventReviewState, origin: NormalizedEventOrigin, proposal: CreateNormalizationRecord['proposal'], modelRunId: string | null, actorEmail: string, createdAt: string): D1PreparedStatement {
		return this.db.prepare(`INSERT INTO normalized_event_versions (
			id, source_intake_id, parent_version_id, version_number, review_state, origin,
			event_statement, proposed_significance_score, proposed_satire_potential_score,
			proposed_suitability, suitability_reason, guardrail_flags_json, model_run_id,
			created_by_email, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(id, intakeId, parentId, versionNumber, state, origin, proposal.eventStatement,
				proposal.proposedSignificanceScore, proposal.proposedSatirePotentialScore,
				proposal.proposedSuitability, proposal.suitabilityReason, JSON.stringify(proposal.guardrailFlags),
				modelRunId, actorEmail, createdAt);
	}

	async reviewNormalization(record: ReviewNormalizationRecord): Promise<boolean> {
		if (record.decision === 'REJECTED') {
			const results = await this.db.batch([
				this.db.prepare("UPDATE normalized_event_versions SET review_state = 'REJECTED', reviewed_by_email = ?, review_reason = ?, reviewed_at = ? WHERE id = ? AND source_intake_id = ? AND review_state = 'PROPOSED'").bind(record.actorEmail, record.reason, record.reviewedAt, record.versionId, record.intakeId),
				this.db.prepare("INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, reason, created_at) SELECT ?, ?, 'SOURCE_INTAKE', ?, 'NORMALIZATION_REJECTED', ?, ? WHERE EXISTS (SELECT 1 FROM normalized_event_versions WHERE id = ? AND review_state = 'REJECTED' AND reviewed_at = ?)").bind(record.auditId, record.actorEmail, record.intakeId, record.reason, record.reviewedAt, record.versionId, record.reviewedAt),
			]);
			return results[0].meta.changes === 1;
		}
		const results = await this.db.batch([
			this.db.prepare("UPDATE normalized_event_versions SET review_state = 'SUPERSEDED', reviewed_by_email = ?, review_reason = 'Superseded by a newly accepted version.', reviewed_at = ? WHERE source_intake_id = ? AND review_state = 'ACCEPTED' AND id <> ?").bind(record.actorEmail, record.reviewedAt, record.intakeId, record.versionId),
			this.db.prepare("UPDATE normalized_event_versions SET review_state = 'ACCEPTED', reviewed_by_email = ?, review_reason = ?, reviewed_at = ? WHERE id = ? AND source_intake_id = ? AND review_state = 'PROPOSED'").bind(record.actorEmail, record.reason, record.reviewedAt, record.versionId, record.intakeId),
			this.db.prepare(`UPDATE source_intakes SET significance_score = ?, satire_potential_score = ?, satire_suitability = ?, suitability_reason = ?, guardrail_flags_json = ?, assessment_reviewed_by_email = ?, assessment_reviewed_at = ?, accepted_model_run_id = ?, updated_by_email = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM normalized_event_versions WHERE id = ? AND review_state = 'ACCEPTED' AND reviewed_at = ?)`)
				.bind(record.proposal.proposedSignificanceScore, record.proposal.proposedSatirePotentialScore,
					record.proposal.proposedSuitability, record.proposal.suitabilityReason,
					JSON.stringify(record.proposal.guardrailFlags), record.actorEmail, record.reviewedAt,
					record.modelRunId, record.actorEmail, record.reviewedAt, record.intakeId,
					record.versionId, record.reviewedAt),
			this.db.prepare("INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, reason, created_at) SELECT ?, ?, 'SOURCE_INTAKE', ?, 'NORMALIZATION_ACCEPTED', ?, ? WHERE EXISTS (SELECT 1 FROM normalized_event_versions WHERE id = ? AND review_state = 'ACCEPTED' AND reviewed_at = ?)").bind(record.auditId, record.actorEmail, record.intakeId, record.reason, record.reviewedAt, record.versionId, record.reviewedAt),
		]);
		return results[1].meta.changes === 1 && results[2].meta.changes === 1;
	}

	async supersedeNormalization(record: Omit<ReviewNormalizationRecord, 'decision' | 'proposal' | 'modelRunId'>): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare("UPDATE normalized_event_versions SET review_state = 'SUPERSEDED', reviewed_by_email = ?, review_reason = ?, reviewed_at = ? WHERE id = ? AND source_intake_id = ? AND review_state = 'ACCEPTED'").bind(record.actorEmail, record.reason, record.reviewedAt, record.versionId, record.intakeId),
			this.db.prepare('UPDATE source_intakes SET accepted_model_run_id = NULL, updated_by_email = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM normalized_event_versions WHERE id = ? AND review_state = \'SUPERSEDED\' AND reviewed_at = ?)').bind(record.actorEmail, record.reviewedAt, record.intakeId, record.versionId, record.reviewedAt),
			this.db.prepare("INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, reason, created_at) SELECT ?, ?, 'SOURCE_INTAKE', ?, 'NORMALIZATION_SUPERSEDED', ?, ? WHERE EXISTS (SELECT 1 FROM normalized_event_versions WHERE id = ? AND review_state = 'SUPERSEDED' AND reviewed_at = ?)").bind(record.auditId, record.actorEmail, record.intakeId, record.reason, record.reviewedAt, record.versionId, record.reviewedAt),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}

	async createGeneratedCandidates(record: CreateGeneratedCandidatesRecord): Promise<boolean> {
		const statements: D1PreparedStatement[] = [insertRun(this.db, record.run)];
		record.candidates.forEach((candidate, index) => {
			statements.push(this.db.prepare(`INSERT INTO satire_candidates (
				id, source_intake_id, proposed_headline, proposed_deck, draft_body_markdown,
				category_id, editorial_notes, status, created_by_email, updated_by_email,
				created_at, updated_at, origin_model_run_id, normalized_event_version_id,
				generation_ordinal, rationale, satirical_mechanism, origin_kind
			) VALUES (?, ?, ?, ?, '', ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MODEL')`)
				.bind(record.candidateIds[index], record.run.sourceIntakeId, candidate.headline, candidate.deck,
					record.categoryId, record.editorialReason, record.run.requestedByEmail,
					record.run.requestedByEmail, record.createdAt, record.createdAt, record.run.id,
					record.run.normalizedEventVersionId, index + 1, candidate.rationale, candidate.satiricalMechanism));
			statements.push(this.db.prepare("INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, to_status, reason, created_at) VALUES (?, ?, 'SATIRE_CANDIDATE', ?, 'GENERATED', 'DRAFT', ?, ?)").bind(record.auditIds[index], record.run.requestedByEmail, record.candidateIds[index], record.editorialReason || null, record.createdAt));
		});
		const results = await this.db.batch(statements);
		return results[0].meta.changes === 1;
	}

	async countGeneratedCandidates(runId: string): Promise<number> {
		const row = await this.db.prepare('SELECT COUNT(*) AS count FROM satire_candidates WHERE origin_model_run_id = ?').bind(runId).first<{ count: number }>();
		return row?.count ?? 0;
	}
}
