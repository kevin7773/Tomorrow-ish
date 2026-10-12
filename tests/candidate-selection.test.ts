import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1EditorialWorkflowRepository } from '../src/data/d1-editorial-workflow-repository';
import { D1GenerationRepository } from '../src/data/d1-generation-repository';
import { CandidateSelectionService } from '../src/services/candidate-selection-service';

const NOW = '2026-10-11T20:00:00.000Z';
const TARGET = { batchId: 'b24b69e8-0816-4c13-90fe-0925feecac00', intakeId: '2c7f63bc-a733-4952-84f3-3bc6048290cb' };
const VERSION = '5ddcc5c9-3fe1-4f1c-bc57-6e749e9d5d4d';
const execute = Symbol('execute');
type Executable = D1PreparedStatement & { [execute]: () => D1Result };

function d1(sqlite: DatabaseSync): D1Database {
	return { prepare(query: string) { let values: unknown[] = []; const statement = {
		bind(...bindings: unknown[]) { values = bindings; return statement; },
		async first<T>() { return (sqlite.prepare(query).get(...values as never[]) as T | undefined) ?? null; },
		async all<T>() { return { success: true, results: sqlite.prepare(query).all(...values as never[]) as T[] } as D1Result<T>; },
		async run<T>() { return statement[execute]() as D1Result<T>; },
		[execute]() { const result = sqlite.prepare(query).run(...values as never[]); return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result; },
	}; return statement as unknown as D1PreparedStatement; },
	async batch<T>(statements: D1PreparedStatement[]) { sqlite.exec('BEGIN IMMEDIATE'); try {
		const result = statements.map((statement) => (statement as Executable)[execute]()); sqlite.exec('COMMIT'); return result as D1Result<T>[];
	} catch (error) { sqlite.exec('ROLLBACK'); throw error; } } } as unknown as D1Database;
}

function fixture(): { sqlite: DatabaseSync; repository: D1EditorialWorkflowRepository; service: CandidateSelectionService } {
	const sqlite = new DatabaseSync(':memory:');
	for (const filename of readdirSync(join(process.cwd(), 'migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
		sqlite.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
	}
	sqlite.exec(`INSERT INTO categories (id,slug,name,created_at) VALUES ('cat','cat','Category','${NOW}');
		INSERT INTO automation_runs (id,trigger_kind,status,started_at,completed_at) VALUES ('${TARGET.batchId}','SCHEDULED','SUCCEEDED','${NOW}','${NOW}');
		INSERT INTO editorial_batches (id,item_count,created_at) VALUES ('${TARGET.batchId}',1,'${NOW}');
		INSERT INTO source_intakes (id,title,neutral_brief,significance_score,satire_potential_score,satire_suitability,editorial_notes,created_by_email,updated_by_email,created_at,updated_at,assessment_reviewed_by_email,assessment_reviewed_at)
		VALUES ('${TARGET.intakeId}','Target','Brief',3,4,'SUITABLE','','editor@test','editor@test','${NOW}','${NOW}','editor@test','${NOW}');
		INSERT INTO editorial_batch_items (batch_id,source_intake_id,ordinal,category_id,workflow_state,selected_by_email,selected_at,created_at,updated_at)
		VALUES ('${TARGET.batchId}','${TARGET.intakeId}',1,'cat','SELECTED','editor@test','${NOW}','${NOW}','${NOW}');
		INSERT INTO normalized_event_versions (id,source_intake_id,version_number,review_state,origin,event_statement,proposed_significance_score,proposed_satire_potential_score,proposed_suitability,suitability_reason,created_by_email,reviewed_by_email,created_at,reviewed_at)
		VALUES ('${VERSION}','${TARGET.intakeId}',1,'ACCEPTED','EDITOR','Event',3,4,'SUITABLE','Reviewed','editor@test','editor@test','${NOW}','${NOW}');
		INSERT INTO source_references (id,source_intake_id,source_title,source_url,publisher_name,source_tier,source_type,created_at,updated_at)
		VALUES ('reference-1','${TARGET.intakeId}','Source','https://example.test/source','Publisher','TIER_1','PRIMARY','${NOW}','${NOW}');
		INSERT INTO satire_candidates (id,source_intake_id,proposed_headline,proposed_deck,draft_body_markdown,category_id,editorial_notes,status,created_by_email,updated_by_email,created_at,updated_at,normalized_event_version_id)
		VALUES ('candidate-1','${TARGET.intakeId}','One','Deck','','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}','${VERSION}'),
		('candidate-2','${TARGET.intakeId}','Two','Deck','','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}','${VERSION}'),
		('candidate-3','${TARGET.intakeId}','Three','Deck','','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}','${VERSION}'),
		('candidate-4','${TARGET.intakeId}','Four','Deck','','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}','${VERSION}'),
		('candidate-5','${TARGET.intakeId}','Five','Deck','','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}','${VERSION}');`);
	const repository = new D1EditorialWorkflowRepository(d1(sqlite));
	let id = 0;
	return { sqlite, repository, service: new CandidateSelectionService(repository, TARGET,
		{ now: () => NOW, createId: () => `selection-event-${++id}` }) };
}

function input(candidateId = 'candidate-1', overrides: Record<string, unknown> = {}) {
	return { ...TARGET, normalizedEventVersionId: VERSION, candidateId, ...overrides };
}

describe('governed candidate selection', () => {
	it('atomically records one active selection and one immutable audit event under concurrency', async () => {
		const { sqlite, repository, service } = fixture();
		const results = await Promise.allSettled([
			service.select({ email: 'Editor@Test' }, input('candidate-1')),
			service.select({ email: 'Editor@Test' }, input('candidate-2')),
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(await repository.findCandidateSelection(TARGET.batchId, TARGET.intakeId)).toMatchObject({ revision: 1 });
		expect(sqlite.prepare('SELECT COUNT(*) count FROM editorial_candidate_selections').get()).toEqual({ count: 1 });
		expect(sqlite.prepare('SELECT COUNT(*) count FROM editorial_candidate_selection_events').get()).toEqual({ count: 1 });
		expect(() => sqlite.exec("UPDATE editorial_candidate_selection_events SET reason='changed'")).toThrow(/append-only/);
		sqlite.close();
	});

	it('is idempotent for duplicate selection and preserves all candidate drafts', async () => {
		const { sqlite, service } = fixture();
		expect(await service.select({ email: 'editor@test' }, input())).toBe('SELECTED');
		expect(await service.select({ email: 'editor@test' }, input())).toBe('UNCHANGED');
		expect(sqlite.prepare('SELECT COUNT(*) count FROM editorial_candidate_selection_events').get()).toEqual({ count: 1 });
		expect(sqlite.prepare("SELECT COUNT(*) count FROM satire_candidates WHERE status='DRAFT' AND draft_body_markdown='' ").get())
			.toEqual({ count: 5 });
		expect(sqlite.prepare('SELECT COUNT(*) count FROM model_runs').get()).toEqual({ count: 0 });
		expect(sqlite.prepare('SELECT COUNT(*) count FROM model_request_reservations').get()).toEqual({ count: 0 });
		sqlite.close();
	});

	it('authorizes only the exact active selection for paid manual body generation', async () => {
		const { sqlite, service } = fixture();
		await expect(service.requireSelectedForBodyGeneration('candidate-1')).rejects.toThrow(/active governed/i);
		await service.select({ email: 'editor@test' }, input('candidate-1'));
		await expect(service.requireSelectedForBodyGeneration('candidate-1')).resolves.toBeUndefined();
		for (const sibling of ['candidate-2', 'candidate-3', 'candidate-4', 'candidate-5']) {
			await expect(service.requireSelectedForBodyGeneration(sibling)).rejects.toThrow(/active governed/i);
		}
		await expect(service.requireSelectedForBodyGeneration('cross-batch-candidate')).rejects.toThrow(/active governed/i);
		await expect(service.requireSelectedForBodyGeneration('cross-intake-candidate')).rejects.toThrow(/active governed/i);
		sqlite.close();
	});

	it('fails closed when the active selection changes before body generation', async () => {
		const { sqlite, service } = fixture();
		await service.select({ email: 'editor@test' }, input('candidate-1'));
		await service.select({ email: 'editor@test' }, input('candidate-2', { reason: 'Governed change.' }));
		await expect(service.requireSelectedForBodyGeneration('candidate-1')).rejects.toThrow(/active governed/i);
		await expect(service.requireSelectedForBodyGeneration('candidate-2')).resolves.toBeUndefined();
		sqlite.close();
	});

	it('atomically creates a body reservation only for the selected smoke candidate', async () => {
		const { sqlite, service } = fixture();
		await service.select({ email: 'editor@test' }, input('candidate-1'));
		const generation = new D1GenerationRepository(d1(sqlite));
		const claim = async (candidateId: string, id: string) => {
			await generation.admitModelBudget({ attemptKey: `key-${id}`, operation: 'GENERATE_ARTICLE_BODY',
				sourceIntakeId: TARGET.intakeId, normalizedEventVersionId: VERSION, candidateId, owner: 'worker',
				budgetDay: '2026-10-12', estimatedCostMicrousd: 1, createdAt: NOW,
				limits: { enabled: true, operationMaxMicrousd: { NORMALIZE: 10, GENERATE_CANDIDATES: 10, GENERATE_ARTICLE_BODY: 10 }, itemMaxMicrousd: 10, dailyMaxMicrousd: 10 } });
			return generation.claimArticleBodyGeneration({
			id, candidateId, sourceIntakeId: TARGET.intakeId, normalizedEventVersionId: VERSION,
			provider: 'test', model: 'test', promptVersion: 'article-body-v2', inputHash: `hash-${id}`,
			inputCharacters: 10, estimatedCostMicrousd: 1, idempotencyKey: `key-${id}`, owner: 'worker',
			requestedByEmail: 'editor@test', sourceWasSensitive: false, cautionReason: null,
			createdAt: NOW, auditId: `audit-${id}`, smokeTarget: TARGET,
			});
		};
		expect(await claim('candidate-2', 'sibling-run')).toBe(false);
		expect(sqlite.prepare('SELECT COUNT(*) count FROM candidate_body_generation_runs').get()).toEqual({ count: 0 });
		expect(await claim('candidate-1', 'selected-run')).toBe(true);
		expect(sqlite.prepare('SELECT candidate_id,status FROM candidate_body_generation_runs').get())
			.toEqual({ candidate_id: 'candidate-1', status: 'PENDING' });
		sqlite.close();
	});

	it('rejects unauthorized, cross-target, cross-intake, and mismatched-normalization selections', async () => {
		const { sqlite, service } = fixture();
		await expect(service.select(null, input())).rejects.toThrow(/authenticated editor/i);
		await expect(service.select({ email: 'editor@test' }, input('candidate-1', { batchId: 'other' }))).rejects.toThrow(/outside/);
		sqlite.exec(`INSERT INTO source_intakes (id,title,neutral_brief,significance_score,satire_potential_score,satire_suitability,editorial_notes,created_by_email,updated_by_email,created_at,updated_at)
			VALUES ('other-intake','Other','Brief',3,3,'SUITABLE','','editor@test','editor@test','${NOW}','${NOW}');
			INSERT INTO satire_candidates (id,source_intake_id,proposed_headline,proposed_deck,draft_body_markdown,category_id,editorial_notes,status,created_by_email,updated_by_email,created_at,updated_at)
			VALUES ('other-candidate','other-intake','Other','Deck','','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}');`);
		await expect(service.select({ email: 'editor@test' }, input('other-candidate'))).rejects.toThrow(/not eligible/);
		await expect(service.select({ email: 'editor@test' }, input('candidate-1', { normalizedEventVersionId: 'wrong' }))).rejects.toThrow(/not eligible/);
		sqlite.close();
	});

	it('allows an explicitly reasoned audited replacement only before body generation', async () => {
		const { sqlite, repository, service } = fixture();
		await service.select({ email: 'first@test' }, input('candidate-1'));
		await expect(service.select({ email: 'second@test' }, input('candidate-2'))).rejects.toThrow(/reason/i);
		expect(await service.select({ email: 'second@test' }, input('candidate-2', { reason: 'Stronger framing.' }))).toBe('CHANGED');
		expect(await repository.findCandidateSelection(TARGET.batchId, TARGET.intakeId)).toMatchObject({ candidateId: 'candidate-2', revision: 2 });
		expect(sqlite.prepare("SELECT previous_candidate_id,event_kind,reason FROM editorial_candidate_selection_events WHERE revision=2").get())
			.toEqual({ previous_candidate_id: 'candidate-1', event_kind: 'SELECTION_CHANGED', reason: 'Stronger framing.' });
		sqlite.prepare("UPDATE satire_candidates SET body_generation_state='PENDING' WHERE id='candidate-2'").run();
		await expect(service.select({ email: 'third@test' }, input('candidate-1', { reason: 'Too late.' }))).rejects.toThrow(/body generation has begun/i);
		expect(await repository.findCandidateSelection(TARGET.batchId, TARGET.intakeId)).toMatchObject({ candidateId: 'candidate-2', revision: 2 });
		sqlite.close();
	});

	it('renders an explicit selection action and keeps manual body generation separate', () => {
		const page = readFileSync(join(process.cwd(), 'src/pages/editorial/candidates/[id].astro'), 'utf8');
		expect(page).toContain('Workflow candidate selection');
		expect(page).toContain('Select for workflow body generation');
		expect(page).toContain('/editorial/actions/candidate-selection');
		expect(page).toContain('name="action" value="generate-body"');
		const action = readFileSync(join(process.cwd(), 'src/pages/editorial/actions/generation.ts'), 'utf8');
		expect(action.indexOf('requireSelectedForBodyGeneration')).toBeLessThan(action.indexOf('getRuntimeModelConfiguration()'));
	});
});
