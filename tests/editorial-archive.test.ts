import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1AutomationRepository } from '../src/data/d1-automation-repository';
import { D1EditorialRepository } from '../src/data/d1-editorial-repository';
import { D1GenerationRepository } from '../src/data/d1-generation-repository';
import {
	archiveMutationSecurityFailureResponse,
	handleEditorialArchiveAction,
} from '../src/lib/editorial-archive-action';
import { createCsrfToken, verifySameOriginMutation } from '../src/security/csrf';
import { authenticateEditorialRequest } from '../src/security/editorial-auth';
import { EditorialService } from '../src/services/editorial-service';

const NOW = '2026-09-14T14:00:00.000Z';
const EDITOR = { email: 'Editor@Tomorrow-ish.news' };
const execute = Symbol('execute');

type ExecutableStatement = D1PreparedStatement & { [execute]: () => D1Result };

function d1Database(sqlite: DatabaseSync): D1Database {
	return {
		prepare(query: string) {
			let bindings: unknown[] = [];
			const statement = {
				bind(...values: unknown[]) {
					bindings = values;
					return statement;
				},
				async first<T>() {
					return (sqlite.prepare(query).get(...bindings as never[]) as T | undefined) ?? null;
				},
				async all<T>() {
					return { success: true, results: sqlite.prepare(query).all(...bindings as never[]) as T[] } as D1Result<T>;
				},
				async run<T>() {
					return statement[execute]() as D1Result<T>;
				},
				[execute]() {
					const result = sqlite.prepare(query).run(...bindings as never[]);
					return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result;
				},
			};
			return statement as unknown as D1PreparedStatement;
		},
		async batch<T>(statements: D1PreparedStatement[]) {
			sqlite.exec('BEGIN IMMEDIATE');
			try {
				const results = statements.map((statement) => (statement as ExecutableStatement)[execute]());
				sqlite.exec('COMMIT');
				return results as D1Result<T>[];
			} catch (error) {
				sqlite.exec('ROLLBACK');
				throw error;
			}
		},
	} as unknown as D1Database;
}

function freshDatabase(): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	const migrationDirectory = join(process.cwd(), 'migrations');
	for (const filename of readdirSync(migrationDirectory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
		database.exec(readFileSync(join(migrationDirectory, filename), 'utf8'));
	}
	database.exec('PRAGMA foreign_keys = ON');
	return database;
}

function insertIntake(database: DatabaseSync, id: string, suitability: string): void {
	database.prepare(`INSERT INTO source_intakes (
		id, title, neutral_brief, significance_score, satire_potential_score, satire_suitability,
		editorial_notes, created_by_email, updated_by_email, created_at, updated_at
	) VALUES (?, ?, 'A neutral factual brief long enough for validation.', 2, 3, ?, '', ?, ?, ?, ?)`)
		.run(id, `Intake ${id}`, suitability, EDITOR.email.toLowerCase(), EDITOR.email.toLowerCase(), NOW, NOW);
}

function insertCandidate(database: DatabaseSync, id: string, intakeId: string, status: string): void {
	database.prepare(`INSERT INTO satire_candidates (
		id, source_intake_id, proposed_headline, proposed_deck, draft_body_markdown,
		category_id, editorial_notes, status, created_by_email, updated_by_email, created_at, updated_at
	) VALUES (?, ?, ?, 'A fictional deck.', 'A fictional draft.', 'cat-community', '', ?, ?, ?, ?, ?)`)
		.run(id, intakeId, `Candidate ${id}`, status, EDITOR.email.toLowerCase(), EDITOR.email.toLowerCase(), NOW, NOW);
}

function attachCandidateProvenance(database: DatabaseSync, candidateId: string, intakeId: string): void {
	database.prepare(`INSERT INTO model_runs (
		id, operation, status, source_intake_id, normalized_event_version_id, provider, model,
		prompt_version, input_hash, output_hash, input_characters, output_characters, latency_ms,
		retry_count, estimated_cost_microusd, candidate_count, idempotency_key,
		requested_by_email, created_at, completed_at
	) VALUES ('model-run', 'GENERATE_CANDIDATES', 'SUCCEEDED', ?, NULL, 'test', 'test',
		'prompt-v1', 'input-hash', 'output-hash', 100, 100, 1, 0, 0, 1, 'model-key', ?, ?, ?)`)
		.run(intakeId, EDITOR.email.toLowerCase(), NOW, NOW);
	database.prepare(`INSERT INTO normalized_event_versions (
		id, source_intake_id, parent_version_id, version_number, review_state, origin,
		event_statement, proposed_significance_score, proposed_satire_potential_score,
		proposed_suitability, suitability_reason, model_run_id, created_by_email, created_at
	) VALUES ('normalized-version', ?, NULL, 1, 'ACCEPTED', 'MODEL', 'A normalized event.',
		2, 3, 'UNSUITABLE', 'Not suitable for satire.', 'model-run', ?, ?)`)
		.run(intakeId, EDITOR.email.toLowerCase(), NOW);
	database.prepare("UPDATE model_runs SET normalized_event_version_id = 'normalized-version' WHERE id = 'model-run'").run();
	database.prepare(`UPDATE satire_candidates SET origin_model_run_id = 'model-run',
		normalized_event_version_id = 'normalized-version', generation_ordinal = 1,
		rationale = 'Retained rationale', satirical_mechanism = 'Retained mechanism',
		origin_kind = 'MODEL', body_generation_state = 'PENDING'
		WHERE id = ?`).run(candidateId);
	database.prepare(`INSERT INTO candidate_body_generation_runs (
		id, status, candidate_id, source_intake_id, normalized_event_version_id, provider, model,
		prompt_version, input_hash, input_characters, estimated_cost_microusd, idempotency_key,
		requested_by_email, source_was_sensitive, failure_classification, created_at, completed_at
	) VALUES ('body-run', 'FAILED', ?, ?, 'normalized-version', 'test', 'test', 'body-v1',
		'body-input', 100, 0, 'body-key', ?, 0, 'PROVIDER_NETWORK', ?, ?)`)
		.run(candidateId, intakeId, EDITOR.email.toLowerCase(), NOW, NOW);
	database.prepare("UPDATE satire_candidates SET body_generation_state = 'FAILED', body_generation_run_id = 'body-run' WHERE id = ?").run(candidateId);
}

describe('editorial queue soft archive', () => {
	it('routes the history page bulk form payload through CSRF, Access identity, service, and success messages', async () => {
		const database = freshDatabase();
		try {
			insertIntake(database, 'u1', 'UNSUITABLE');
			insertIntake(database, 'u2', 'UNSUITABLE');
			insertIntake(database, 's1', 'SUITABLE');
			insertCandidate(database, 'r1', 's1', 'REJECTED');
			insertCandidate(database, 'r2', 's1', 'REJECTED');
			insertCandidate(database, 'd1', 's1', 'DRAFT');
			database.prepare(`INSERT INTO stories (
				id, slug, headline, deck, body_markdown, edition_date, published_at, category_id,
				status, social_excerpt, tags_json, created_at, updated_at
			) VALUES ('story-1', 'story-one', 'Story one', 'Deck', 'Body', '2026-09-14', ?,
				'cat-community', 'PUBLISHED', 'Excerpt', '[]', ?, ?)`)
				.run(NOW, NOW, NOW);

			const repository = new D1EditorialRepository(d1Database(database));
			const service = new EditorialService(repository, {
				now: () => NOW,
				createId: (() => { let id = 0; return () => `form-${++id}`; })(),
			});
			const token = createCsrfToken();
			const environment = {
				CF_ACCESS_TEAM_DOMAIN: 'https://tomorrow-ish.cloudflareaccess.com',
				CF_ACCESS_AUD: 'access-audience',
				EDITORIAL_ALLOWED_EMAIL: EDITOR.email.toLowerCase(),
			};

			async function submit(action: string, expectedCount: string): Promise<Response> {
				const form = new FormData();
				form.set('csrf_token', token);
				form.set('action', action);
				form.set('expectedCount', expectedCount);
				form.set('returnPath', '/editorial/history');
				form.set('archiveReason', '');
				expect(form.has('actorEmail')).toBe(false);
				const request = new Request('https://tomorrow-ish.news/editorial/actions/archive', {
					method: 'POST',
					headers: {
						Origin: 'https://tomorrow-ish.news',
						'Cf-Access-Jwt-Assertion': 'signed-token',
					},
					body: form,
				});
				await expect(verifySameOriginMutation(request, token, 'https://tomorrow-ish.news')).resolves.toBeUndefined();
				const identity = await authenticateEditorialRequest(request, environment, {
					verifyToken: async () => ({ email: EDITOR.email }),
				});
				return handleEditorialArchiveAction(await request.formData(), identity, service);
			}

			const intakeResponse = await submit('archive-all-unsuitable-intakes', '2');
			expect(intakeResponse.status).toBe(303);
			expect(intakeResponse.headers.get('Location')).toBe('/editorial/history?message=intakes-bulk-archived&count=2');
			const candidateResponse = await submit('archive-all-rejected-candidates', '2');
			expect(candidateResponse.status).toBe(303);
			expect(candidateResponse.headers.get('Location')).toBe('/editorial/history?message=candidates-bulk-archived&count=2');
			expect(database.prepare('SELECT COUNT(*) AS count FROM source_intakes WHERE archived_at IS NOT NULL').get()).toMatchObject({ count: 2 });
			expect(database.prepare('SELECT COUNT(*) AS count FROM satire_candidates WHERE archived_at IS NOT NULL').get()).toMatchObject({ count: 2 });
			expect(database.prepare("SELECT COUNT(*) AS count FROM editorial_audit_log WHERE action='ARCHIVED'").get()).toMatchObject({ count: 4 });
			expect(database.prepare("SELECT COUNT(*) AS count FROM editorial_audit_log WHERE action='ARCHIVED' AND actor_email=?").get(EDITOR.email.toLowerCase())).toMatchObject({ count: 4 });
			expect(database.prepare("SELECT COUNT(*) AS count FROM stories WHERE id='story-1' AND status='PUBLISHED'").get()).toMatchObject({ count: 1 });
		} finally {
			database.close();
		}
	});

	it('fails malformed and stale history bulk counts closed with explicit bounded errors', async () => {
		const database = freshDatabase();
		try {
			insertIntake(database, 'u1', 'UNSUITABLE');
			const repository = new D1EditorialRepository(d1Database(database));
			const service = new EditorialService(repository, { now: () => NOW, createId: () => 'never-used' });
			for (const expectedCount of [undefined, '', '2']) {
				const form = new FormData();
				form.set('action', 'archive-all-unsuitable-intakes');
				if (expectedCount !== undefined) form.set('expectedCount', expectedCount);
				form.set('returnPath', '/editorial/history');
				const response = await handleEditorialArchiveAction(form, EDITOR, service);
				expect(response.status).toBe(303);
				expect(response.headers.get('Location')).toBe(expectedCount !== '2'
					? '/editorial/history?error=invalid-request'
					: '/editorial/history?error=archive-preview-stale');
			}
			await expect(service.archiveAllUnsuitableIntakes(EDITOR, { expectedCount: 1 })).rejects.toThrow(/Expected archive count/);
			expect(database.prepare('SELECT COUNT(*) AS count FROM source_intakes WHERE archived_at IS NOT NULL').get()).toMatchObject({ count: 0 });
			expect(database.prepare("SELECT COUNT(*) AS count FROM editorial_audit_log WHERE action='ARCHIVED'").get()).toMatchObject({ count: 0 });

			const securityResponse = archiveMutationSecurityFailureResponse('/editorial/actions/archive', 'POST');
			expect(securityResponse?.status).toBe(303);
			expect(securityResponse?.headers.get('Location')).toBe('/editorial/history?error=archive-request-verification-failed');
			expect(archiveMutationSecurityFailureResponse('/editorial/actions/intakes', 'POST')).toBeNull();
		} finally {
			database.close();
		}
	});

	it('enforces terminal eligibility, required actors, immutable status, and clean restore in the schema', () => {
		const database = freshDatabase();
		try {
			insertIntake(database, 'unsuitable', 'UNSUITABLE');
			insertIntake(database, 'suitable', 'SUITABLE');
			insertCandidate(database, 'rejected', 'unsuitable', 'REJECTED');
			insertCandidate(database, 'draft', 'suitable', 'DRAFT');

			expect(() => database.prepare("UPDATE source_intakes SET archived_at = ?, archived_by_email = ? WHERE id = 'unsuitable'").run(NOW, null)).toThrow(/archive metadata/);
			expect(() => database.prepare("UPDATE source_intakes SET archived_at = ?, archived_by_email = ? WHERE id = 'suitable'").run(NOW, EDITOR.email)).toThrow(/only unsuitable/);
			database.prepare("UPDATE source_intakes SET archived_at = ?, archived_by_email = ?, archive_reason = 'Terminal cleanup' WHERE id = 'unsuitable'").run(NOW, EDITOR.email);
			expect(() => database.prepare("UPDATE source_intakes SET satire_suitability = 'SUITABLE' WHERE id = 'unsuitable'").run()).toThrow(/restore/);
			database.prepare("UPDATE source_intakes SET archived_at = NULL, archived_by_email = NULL, archive_reason = NULL WHERE id = 'unsuitable'").run();
			expect(database.prepare("SELECT archived_at, archived_by_email, archive_reason FROM source_intakes WHERE id = 'unsuitable'").get()).toMatchObject({ archived_at: null, archived_by_email: null, archive_reason: null });

			expect(() => database.prepare("UPDATE satire_candidates SET archived_at = ?, archived_by_email = ? WHERE id = 'draft'").run(NOW, EDITOR.email)).toThrow(/only rejected/);
			expect(() => database.prepare("UPDATE satire_candidates SET archived_at = ?, archived_by_email = ? WHERE id = 'rejected'").run(NOW, null)).toThrow(/archive metadata/);
			database.prepare("UPDATE satire_candidates SET archived_at = ?, archived_by_email = ? WHERE id = 'rejected'").run(NOW, EDITOR.email);
			expect(() => database.prepare("UPDATE satire_candidates SET status = 'DRAFT' WHERE id = 'rejected'").run()).toThrow(/restore/);
			database.prepare("UPDATE satire_candidates SET archived_at = NULL, archived_by_email = NULL, archive_reason = NULL WHERE id = 'rejected'").run();
			expect(database.prepare("SELECT status, archived_at FROM satire_candidates WHERE id = 'rejected'").get()).toMatchObject({ status: 'REJECTED', archived_at: null });
		} finally {
			database.close();
		}
	});

	it('removes archived records from active lists while preserving history, direct lookup, status, and audit', async () => {
		const database = freshDatabase();
		try {
			insertIntake(database, 'intake-1', 'UNSUITABLE');
			insertIntake(database, 'intake-active', 'SUITABLE');
			insertCandidate(database, 'candidate-1', 'intake-1', 'REJECTED');
			attachCandidateProvenance(database, 'candidate-1', 'intake-1');
			insertCandidate(database, 'candidate-active', 'intake-active', 'DRAFT');
			const repository = new D1EditorialRepository(d1Database(database));
			const service = new EditorialService(repository, { now: () => NOW, createId: (() => { let id = 0; return () => `audit-${++id}`; })() });
			await expect(service.archiveUnsuitableIntake(EDITOR, { id: 'intake-active' })).rejects.toThrow(/Only an unsuitable/);
			await expect(service.archiveRejectedCandidate(EDITOR, { id: 'candidate-active' })).rejects.toThrow(/Only a rejected/);
			await expect(service.archiveUnsuitableIntake(EDITOR, { id: 'intake-1', archiveReason: 'x'.repeat(2_001) })).rejects.toThrow(/2000/);

			await service.archiveUnsuitableIntake(EDITOR, { id: 'intake-1', archiveReason: 'Queue cleanup' });
			expect((await repository.listIntakes()).map((item) => item.id)).toEqual(['intake-active']);
			expect((await repository.listArchivedIntakes()).map((item) => item.id)).toEqual(['intake-1']);
			expect(await repository.findIntakeById('intake-1')).toMatchObject({ satireSuitability: 'UNSUITABLE', archivedAt: NOW, archiveReason: 'Queue cleanup' });
			expect(await repository.listAuditEntries('SOURCE_INTAKE', 'intake-1')).toEqual([expect.objectContaining({ action: 'ARCHIVED', actorEmail: EDITOR.email.toLowerCase(), reason: 'Queue cleanup' })]);

			await service.archiveRejectedCandidate(EDITOR, { id: 'candidate-1', archiveReason: 'Rejected option' });
			expect((await repository.listCandidates()).map((item) => item.id)).toEqual(['candidate-active']);
			expect((await repository.listArchivedCandidates()).map((item) => item.id)).toEqual(['candidate-1']);
			expect(await repository.findCandidateById('candidate-1')).toMatchObject({
				status: 'REJECTED', archivedAt: NOW, sourceIntakeId: 'intake-1',
				originModelRunId: 'model-run', normalizedEventVersionId: 'normalized-version',
				generationOrdinal: 1, rationale: 'Retained rationale', satiricalMechanism: 'Retained mechanism',
				bodyGenerationState: 'FAILED', bodyGenerationRunId: 'body-run',
			});
			expect(database.prepare("SELECT COUNT(*) AS count FROM model_runs WHERE id = 'model-run'").get()).toMatchObject({ count: 1 });
			expect(database.prepare("SELECT COUNT(*) AS count FROM candidate_body_generation_runs WHERE id = 'body-run'").get()).toMatchObject({ count: 1 });

			await service.restoreIntake(EDITOR, { id: 'intake-1', archiveReason: 'Archived by mistake' });
			await service.restoreCandidate(EDITOR, { id: 'candidate-1', archiveReason: 'Archived by mistake' });
			expect((await repository.listIntakes()).map((item) => item.id).sort()).toEqual(['intake-1', 'intake-active']);
			expect((await repository.listCandidates()).map((item) => item.id).sort()).toEqual(['candidate-1', 'candidate-active']);
			expect(await repository.listAuditEntries('SATIRE_CANDIDATE', 'candidate-1')).toEqual(expect.arrayContaining([
				expect.objectContaining({ action: 'RESTORED', reason: 'Archived by mistake' }),
				expect.objectContaining({ action: 'ARCHIVED', reason: 'Rejected option' }),
			]));
		} finally {
			database.close();
		}
	});

	it('fails stale bulk previews closed and archives only hard-coded terminal states with one audit per row', async () => {
		const database = freshDatabase();
		try {
			for (const [id, status] of [['u1', 'UNSUITABLE'], ['u2', 'UNSUITABLE'], ['s1', 'SUITABLE'], ['x1', 'SENSITIVE'], ['n1', 'UNREVIEWED']]) insertIntake(database, id, status);
			for (const [id, status] of [['r1', 'REJECTED'], ['r2', 'REJECTED'], ['d1', 'DRAFT'], ['v1', 'REVIEW'], ['a1', 'APPROVED']]) insertCandidate(database, id, 's1', status);
			const repository = new D1EditorialRepository(d1Database(database));
			const service = new EditorialService(repository, { now: () => NOW, createId: (() => { let id = 0; return () => `bulk-${++id}`; })() });

			await expect(service.archiveAllUnsuitableIntakes(EDITOR, { expectedCount: '1' })).rejects.toMatchObject({ code: 'conflict' });
			expect((await repository.getArchiveCounts()).unsuitableIntakes).toBe(2);
			await expect(repository.archiveAllUnsuitableIntakes({
				actorEmail: EDITOR.email.toLowerCase(), archivedAt: NOW, reason: null,
				auditIdPrefix: 'raced-preview', expectedCount: 1,
			})).resolves.toBe(0);
			expect(database.prepare("SELECT COUNT(*) AS count FROM editorial_audit_log WHERE action = 'ARCHIVED'").get()).toMatchObject({ count: 0 });
			await expect(service.archiveAllUnsuitableIntakes(EDITOR, { expectedCount: '2', archiveReason: 'Bulk cleanup' })).resolves.toBe(2);
			await expect(service.archiveAllRejectedCandidates(EDITOR, { expectedCount: '2', archiveReason: 'Bulk cleanup' })).resolves.toBe(2);

			expect(database.prepare("SELECT COUNT(*) AS count FROM source_intakes WHERE archived_at IS NOT NULL").get()).toMatchObject({ count: 2 });
			expect(database.prepare("SELECT COUNT(*) AS count FROM satire_candidates WHERE archived_at IS NOT NULL").get()).toMatchObject({ count: 2 });
			expect(database.prepare("SELECT COUNT(*) AS count FROM editorial_audit_log WHERE action = 'ARCHIVED'").get()).toMatchObject({ count: 4 });
			expect(database.prepare("SELECT COUNT(*) AS count FROM source_intakes WHERE satire_suitability <> 'UNSUITABLE' AND archived_at IS NOT NULL").get()).toMatchObject({ count: 0 });
			expect(database.prepare("SELECT COUNT(*) AS count FROM satire_candidates WHERE status <> 'REJECTED' AND archived_at IS NOT NULL").get()).toMatchObject({ count: 0 });
			expect(database.prepare("SELECT COUNT(*) AS count FROM stories").get()).toMatchObject({ count: 0 });
			expect(database.prepare("SELECT COUNT(*) AS count FROM source_intakes WHERE updated_at <> ?").get(NOW)).toMatchObject({ count: 0 });
		} finally {
			database.close();
		}
	});

	it('keeps archived intake identity and URL known to automation dedupe', async () => {
		const database = freshDatabase();
		try {
			insertIntake(database, 'known-intake', 'UNSUITABLE');
			database.prepare(`INSERT INTO source_references (
				id, source_intake_id, source_title, source_url, publisher_name, source_tier,
				source_type, published_at, created_at, updated_at
			) VALUES ('known-reference', 'known-intake', 'Known source', 'https://example.test/known', 'Example', 'TIER_1', 'PRIMARY', NULL, ?, ?)`)
				.run(NOW, NOW);
			database.prepare(`INSERT INTO automation_sources (
				item_identity, source_url, source_intake_id, category_id, first_seen_at, last_seen_at
			) VALUES ('known-item', 'https://example.test/known', 'known-intake', 'cat-community', ?, ?)`)
				.run(NOW, NOW);
			const db = d1Database(database);
			const editorial = new D1EditorialRepository(db);
			const automation = new D1AutomationRepository(db);
			const generation = new D1GenerationRepository(db);
			await editorial.archiveUnsuitableIntake({ id: 'known-intake', actorEmail: EDITOR.email, archivedAt: NOW, reason: null, auditId: 'audit-known' });

			expect(await automation.findSource('known-item', 'https://example.test/known')).toMatchObject({ sourceIntakeId: 'known-intake' });
			expect(await automation.findIntakeIdsBySourceUrl('https://example.test/known')).toEqual(['known-intake']);
			expect(await automation.findKnownSources([{ itemIdentity: 'known-item', sourceUrl: 'https://example.test/known' }])).toEqual([
				expect.objectContaining({ sourceIntakeIds: ['known-intake'], source: expect.objectContaining({ sourceIntakeId: 'known-intake' }) }),
			]);
			expect(await generation.findIntakeForGeneration('known-intake')).toBeNull();
		} finally {
			database.close();
		}
	});

	it('keeps archive scope out of stories, publication, scheduling, ranking, providers, and known-source lookups', () => {
		const migration = readFileSync(join(process.cwd(), 'migrations/0013_editorial_queue_archiving.sql'), 'utf8');
		const archiveRoute = readFileSync(join(process.cwd(), 'src/pages/editorial/actions/archive.ts'), 'utf8');
		const historyPage = readFileSync(join(process.cwd(), 'src/pages/editorial/history.astro'), 'utf8');
		const messageComponent = readFileSync(join(process.cwd(), 'src/components/EditorialMessage.astro'), 'utf8');
		const intakeDetail = readFileSync(join(process.cwd(), 'src/pages/editorial/intakes/[id].astro'), 'utf8');
		const candidateDetail = readFileSync(join(process.cwd(), 'src/pages/editorial/candidates/[id].astro'), 'utf8');
		const automation = readFileSync(join(process.cwd(), 'src/data/d1-automation-repository.ts'), 'utf8');
		const knownSources = automation.slice(automation.indexOf('async findKnownSources'), automation.indexOf('async registerExistingSource'));
		expect(migration).not.toMatch(/ALTER TABLE stories|UPDATE stories|INSERT INTO stories/);
		expect(migration).not.toMatch(/DELETE FROM/);
		expect(archiveRoute).not.toMatch(/publish|schedule|provider|ranking/i);
		expect(historyPage.match(/method="post" action="\/editorial\/actions\/archive"/g)).toHaveLength(2);
		expect(historyPage.match(/name="csrf_token" value=\{csrfToken\}/g)).toHaveLength(2);
		expect(historyPage.match(/name="expectedCount"/g)).toHaveLength(2);
		expect(historyPage).toContain('value="archive-all-unsuitable-intakes"');
		expect(historyPage).toContain('value="archive-all-rejected-candidates"');
		expect(messageComponent).toContain("'archive-request-verification-failed'");
		expect(messageComponent).toContain("'archive-preview-stale'");
		expect(messageComponent).toContain("'archive-operation-failed'");
		expect(intakeDetail).toContain('{!intake.archivedAt && (');
		expect(intakeDetail).toContain('value="restore-intake"');
		expect(candidateDetail).toContain('candidate.archivedAt ? (');
		expect(candidateDetail).toContain('value="restore-candidate"');
		expect(knownSources).not.toContain('archived_at');
		expect(automation).toMatch(/listGenerationReadySources[\s\S]*intake\.archived_at IS NULL/);
	});
});
