import type {
	AutomationItemResult,
	AutomationReadiness,
	AutomationRun,
	AutomationRunStatus,
	AutomationSource,
} from '../domain/automation';
import type {
	AutomationRepository,
	CompleteAutomationRunRecord,
	CreateAutomatedIntakeRecord,
	KnownAutomationDiscovery,
	StartAutomationRunRecord,
} from './automation-repository';

const MAX_DISCOVERY_LOOKUP_ITEMS = 30;

interface SourceRow {
	item_identity: string; source_url: string; source_intake_id: string; category_id: string;
	first_seen_at: string; last_seen_at: string;
}

interface RunRow {
	id: string; trigger_kind: AutomationRun['trigger']; status: AutomationRunStatus;
	discovered_count: number; processed_count: number; intake_count: number;
	generated_count: number; skipped_count: number; failed_count: number;
	failure_reason: string | null; started_at: string; completed_at: string | null;
}

interface ItemRow {
	item_identity: string; source_url: string | null; outcome: AutomationItemResult['outcome'];
	reason: string; source_intake_id: string | null; normalized_event_version_id: string | null;
	model_run_id: string | null;
}

interface KnownDiscoveryRow {
	input_ordinal: number; discovery_item_identity: string; discovery_source_url: string;
	registered_item_identity: string | null; registered_source_url: string | null;
	registered_source_intake_id: string | null; registered_category_id: string | null;
	registered_first_seen_at: string | null; registered_last_seen_at: string | null;
	reference_intake_id: string | null; version_id: string | null;
	suitability: AutomationReadiness['suitability']; successful_runs: number | null;
}

function mapSource(row: SourceRow): AutomationSource {
	return {
		itemIdentity: row.item_identity, sourceUrl: row.source_url,
		sourceIntakeId: row.source_intake_id, categoryId: row.category_id,
		firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
	};
}

function mapRun(row: RunRow): AutomationRun {
	return {
		id: row.id, trigger: row.trigger_kind, status: row.status,
		discoveredCount: row.discovered_count, processedCount: row.processed_count,
		intakeCount: row.intake_count, generatedCount: row.generated_count,
		skippedCount: row.skipped_count, failedCount: row.failed_count,
		failureReason: row.failure_reason, startedAt: row.started_at, completedAt: row.completed_at,
	};
}

function mapItem(row: ItemRow): AutomationItemResult {
	return {
		itemIdentity: row.item_identity, sourceUrl: row.source_url, outcome: row.outcome,
		reason: row.reason, sourceIntakeId: row.source_intake_id,
		normalizedEventVersionId: row.normalized_event_version_id, modelRunId: row.model_run_id,
	};
}

export class D1AutomationRepository implements AutomationRepository {
	constructor(private readonly db: D1Database) {}

	async startRun(record: StartAutomationRunRecord): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`UPDATE automation_runs
				SET status = 'FAILED', failure_reason = 'STALE_RUN_RECOVERED', completed_at = ?
				WHERE status = 'RUNNING' AND started_at < ?`)
				.bind(record.startedAt, record.staleBefore),
			this.db.prepare(`INSERT OR IGNORE INTO automation_runs
				(id, trigger_kind, status, started_at) VALUES (?, ?, 'RUNNING', ?)`)
				.bind(record.id, record.trigger, record.startedAt),
		]);
		return results[1].meta.changes === 1;
	}

	async completeRun(record: CompleteAutomationRunRecord): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE automation_runs SET
			status = ?, discovered_count = ?, processed_count = ?, intake_count = ?,
			generated_count = ?, skipped_count = ?, failed_count = ?, failure_reason = ?, completed_at = ?
			WHERE id = ? AND status = 'RUNNING'`)
			.bind(record.status, record.discoveredCount, record.processedCount, record.intakeCount,
				record.generatedCount, record.skippedCount, record.failedCount, record.failureReason,
				record.completedAt, record.id)
			.run();
		return result.meta.changes === 1;
	}

	async recordItem(runId: string, itemNumber: number, result: AutomationItemResult, createdAt: string): Promise<void> {
		await this.db.prepare(`INSERT INTO automation_run_items (
			run_id, item_number, item_identity, source_url, outcome, reason, source_intake_id,
			normalized_event_version_id, model_run_id, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(runId, itemNumber, result.itemIdentity, result.sourceUrl, result.outcome, result.reason,
				result.sourceIntakeId, result.normalizedEventVersionId, result.modelRunId, createdAt)
			.run();
	}

	async categoryExists(categoryId: string): Promise<boolean> {
		return Boolean(await this.db.prepare('SELECT 1 FROM categories WHERE id = ? LIMIT 1').bind(categoryId).first());
	}

	async findSource(itemIdentity: string, sourceUrl: string): Promise<AutomationSource | null> {
		const row = await this.db.prepare(`SELECT * FROM automation_sources
			WHERE item_identity = ? OR source_url = ? LIMIT 1`)
			.bind(itemIdentity, sourceUrl).first<SourceRow>();
		return row ? mapSource(row) : null;
	}

	async findIntakeIdsBySourceUrl(sourceUrl: string): Promise<string[]> {
		const rows = await this.db.prepare(`SELECT DISTINCT source_intake_id
			FROM source_references WHERE source_url = ? ORDER BY source_intake_id LIMIT 2`)
			.bind(sourceUrl).all<{ source_intake_id: string }>();
		return rows.results.map((row) => row.source_intake_id);
	}

	async findKnownSources(
		items: readonly Pick<import('../domain/automation').DiscoveryItem, 'itemIdentity' | 'sourceUrl'>[],
	): Promise<KnownAutomationDiscovery[]> {
		const bounded = items.filter((item): item is typeof item & { sourceUrl: string } => Boolean(item.sourceUrl))
			.slice(0, MAX_DISCOVERY_LOOKUP_ITEMS);
		if (bounded.length === 0) return [];
		const values = bounded.map(() => '(?, ?, ?)').join(', ');
		const bindings = bounded.flatMap((item, inputOrdinal) => [inputOrdinal, item.itemIdentity, item.sourceUrl]);
		const rows = await this.db.prepare(`WITH discovered(input_ordinal, item_identity, source_url) AS (
			VALUES ${values}
		)
		SELECT discovered.input_ordinal,
			discovered.item_identity AS discovery_item_identity,
			discovered.source_url AS discovery_source_url,
			registered.item_identity AS registered_item_identity,
			registered.source_url AS registered_source_url,
			registered.source_intake_id AS registered_source_intake_id,
			registered.category_id AS registered_category_id,
			registered.first_seen_at AS registered_first_seen_at,
			registered.last_seen_at AS registered_last_seen_at,
			reference.source_intake_id AS reference_intake_id,
			version.id AS version_id,
			version.proposed_suitability AS suitability,
			(SELECT COUNT(*) FROM model_runs AS run
			 WHERE run.normalized_event_version_id = version.id
			 AND run.operation = 'GENERATE_CANDIDATES' AND run.status = 'SUCCEEDED') AS successful_runs
		FROM discovered
		LEFT JOIN automation_sources AS registered
			ON registered.item_identity = discovered.item_identity OR registered.source_url = discovered.source_url
		LEFT JOIN source_references AS reference ON reference.source_url = discovered.source_url
		LEFT JOIN normalized_event_versions AS version
			ON version.source_intake_id = COALESCE(registered.source_intake_id, reference.source_intake_id)
			AND version.review_state = 'ACCEPTED'
		WHERE registered.item_identity IS NOT NULL OR reference.source_intake_id IS NOT NULL
		ORDER BY discovered.input_ordinal, reference.source_intake_id`)
			.bind(...bindings).all<KnownDiscoveryRow>();
		const known = new Map<number, KnownAutomationDiscovery>();
		for (const row of rows.results) {
			let match = known.get(row.input_ordinal);
			if (!match) {
				const source = row.registered_item_identity && row.registered_source_url
					&& row.registered_source_intake_id && row.registered_category_id
					&& row.registered_first_seen_at && row.registered_last_seen_at
					? mapSource({
						item_identity: row.registered_item_identity,
						source_url: row.registered_source_url,
						source_intake_id: row.registered_source_intake_id,
						category_id: row.registered_category_id,
						first_seen_at: row.registered_first_seen_at,
						last_seen_at: row.registered_last_seen_at,
					})
					: null;
				match = {
					itemIdentity: row.discovery_item_identity,
					sourceUrl: row.discovery_source_url,
					source,
					sourceIntakeIds: [],
					normalizedEventVersionId: row.version_id,
					suitability: row.suitability,
					successfulGenerationRuns: row.successful_runs ?? 0,
				};
				known.set(row.input_ordinal, match);
			}
			const intakeId = row.registered_source_intake_id ?? row.reference_intake_id;
			if (intakeId && !match.sourceIntakeIds.includes(intakeId)) match.sourceIntakeIds.push(intakeId);
		}
		return [...known.values()];
	}

	async registerExistingSource(source: import('../domain/automation').DiscoveredSource, intakeId: string, seenAt: string): Promise<boolean> {
		const result = await this.db.prepare(`INSERT OR IGNORE INTO automation_sources
			(item_identity, source_url, source_intake_id, category_id, first_seen_at, last_seen_at)
			SELECT ?, ?, ?, ?, ?, ?
			WHERE EXISTS (SELECT 1 FROM source_intakes WHERE id = ?)
			AND EXISTS (SELECT 1 FROM categories WHERE id = ?)`)
			.bind(source.itemIdentity, source.sourceUrl, intakeId, source.categoryId, seenAt, seenAt,
				intakeId, source.categoryId).run();
		return result.meta.changes === 1;
	}

	async createAutomatedIntake(record: CreateAutomatedIntakeRecord): Promise<boolean> {
		const { source } = record;
		const results = await this.db.batch([
			this.db.prepare(`INSERT INTO source_intakes (
				id, title, neutral_brief, significance_score, satire_potential_score,
				satire_suitability, editorial_notes, created_by_email, updated_by_email,
				created_at, updated_at
			) SELECT ?, ?, ?, 1, 1, 'UNREVIEWED', 'Automated discovery; awaiting editorial assessment.', ?, ?, ?, ?
			WHERE EXISTS (SELECT 1 FROM categories WHERE id = ?)
			AND NOT EXISTS (SELECT 1 FROM automation_sources WHERE item_identity = ? OR source_url = ?)
			AND NOT EXISTS (SELECT 1 FROM source_references WHERE source_url = ?)`)
				.bind(record.intakeId, source.title, source.neutralBrief, record.actorEmail,
					record.actorEmail, record.createdAt, record.createdAt, source.categoryId,
					source.itemIdentity, source.sourceUrl, source.sourceUrl),
			this.db.prepare(`INSERT INTO source_references (
				id, source_intake_id, source_title, source_url, publisher_name,
				source_tier, source_type, published_at, created_at, updated_at
			) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE EXISTS (SELECT 1 FROM source_intakes WHERE id = ?)`)
				.bind(record.referenceId, record.intakeId, source.sourceTitle, source.sourceUrl,
					source.publisherName, source.sourceTier, source.sourceType, source.publishedAt,
					record.createdAt, record.createdAt, record.intakeId),
			this.db.prepare(`INSERT INTO editorial_audit_log
				(id, actor_email, entity_type, entity_id, action, created_at)
				SELECT ?, ?, 'SOURCE_INTAKE', ?, 'AUTOMATION_CREATED', ?
				WHERE EXISTS (SELECT 1 FROM source_references WHERE id = ?)`)
				.bind(record.auditIds[0], record.actorEmail, record.intakeId, record.createdAt, record.referenceId),
			this.db.prepare(`INSERT INTO editorial_audit_log
				(id, actor_email, entity_type, entity_id, action, created_at)
				SELECT ?, ?, 'SOURCE_REFERENCE', ?, 'AUTOMATION_CREATED', ?
				WHERE EXISTS (SELECT 1 FROM source_references WHERE id = ?)`)
				.bind(record.auditIds[1], record.actorEmail, record.referenceId, record.createdAt, record.referenceId),
			this.db.prepare(`INSERT INTO automation_sources
				(item_identity, source_url, source_intake_id, category_id, first_seen_at, last_seen_at)
				SELECT ?, ?, ?, ?, ?, ?
				WHERE EXISTS (SELECT 1 FROM source_references WHERE id = ?)`)
				.bind(source.itemIdentity, source.sourceUrl, record.intakeId, source.categoryId,
					record.createdAt, record.createdAt, record.referenceId),
		]);
		return results[0].meta.changes === 1 && results[4].meta.changes === 1;
	}

	async listGenerationReadySources(limit: number): Promise<AutomationSource[]> {
		const rows = await this.db.prepare(`SELECT source.* FROM automation_sources AS source
			JOIN source_intakes AS intake
				ON intake.id = source.source_intake_id AND intake.archived_at IS NULL
			JOIN normalized_event_versions AS version
				ON version.source_intake_id = source.source_intake_id
				AND version.review_state = 'ACCEPTED'
				AND version.proposed_suitability = 'SUITABLE'
			WHERE NOT EXISTS (
				SELECT 1 FROM model_runs AS run
				WHERE run.normalized_event_version_id = version.id
				AND run.operation = 'GENERATE_CANDIDATES'
				AND run.status = 'SUCCEEDED'
			)
			ORDER BY source.first_seen_at ASC LIMIT ?`)
			.bind(limit).all<SourceRow>();
		return rows.results.map(mapSource);
	}

	async getReadiness(source: AutomationSource): Promise<AutomationReadiness> {
		const row = await this.db.prepare(`SELECT
			version.id AS version_id, version.proposed_suitability AS suitability,
			(SELECT COUNT(*) FROM model_runs AS run
			 WHERE run.normalized_event_version_id = version.id
			 AND run.operation = 'GENERATE_CANDIDATES' AND run.status = 'SUCCEEDED') AS successful_runs
			FROM source_intakes AS intake
			LEFT JOIN normalized_event_versions AS version
				ON version.source_intake_id = intake.id AND version.review_state = 'ACCEPTED'
			WHERE intake.id = ? LIMIT 1`)
			.bind(source.sourceIntakeId)
			.first<{ version_id: string | null; suitability: AutomationReadiness['suitability']; successful_runs: number }>();
		return {
			source,
			normalizedEventVersionId: row?.version_id ?? null,
			suitability: row?.suitability ?? null,
			successfulGenerationRuns: row?.successful_runs ?? 0,
		};
	}

	async getLastRun(): Promise<AutomationRun | null> {
		const row = await this.db.prepare('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 1').first<RunRow>();
		return row ? mapRun(row) : null;
	}

	async listRunItems(runId: string): Promise<AutomationItemResult[]> {
		const rows = await this.db.prepare(`SELECT item_identity, source_url, outcome, reason,
			source_intake_id, normalized_event_version_id, model_run_id
			FROM automation_run_items WHERE run_id = ? ORDER BY item_number`)
			.bind(runId).all<ItemRow>();
		return rows.results.map(mapItem);
	}
}
