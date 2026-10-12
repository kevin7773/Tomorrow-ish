import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1GenerationRepository } from '../src/data/d1-generation-repository';
import type { AdmitModelBudgetRecord, ModelBudgetLimits } from '../src/data/generation-repository';

const NOW = '2026-10-12T12:00:00.000Z';
const execute = Symbol('execute');
type ExecutableStatement = D1PreparedStatement & { [execute]: () => D1Result };

function d1(sqlite: DatabaseSync): D1Database {
	return { prepare(query: string) { let bindings: unknown[] = []; const statement = {
		bind(...values: unknown[]) { bindings = values; return statement; },
		async first<T>() { return (sqlite.prepare(query).get(...bindings as never[]) as T | undefined) ?? null; },
		async all<T>() { return { success: true, results: sqlite.prepare(query).all(...bindings as never[]) as T[] } as D1Result<T>; },
		async run<T>() { return statement[execute]() as D1Result<T>; },
		[execute]() { const result = sqlite.prepare(query).run(...bindings as never[]); return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result; },
	}; return statement as unknown as D1PreparedStatement; },
	async batch<T>(statements: D1PreparedStatement[]) { sqlite.exec('BEGIN IMMEDIATE'); try {
		const results = statements.map((statement) => (statement as ExecutableStatement)[execute]()); sqlite.exec('COMMIT'); return results as D1Result<T>[];
	} catch (error) { sqlite.exec('ROLLBACK'); throw error; } } } as unknown as D1Database;
}

function database(): DatabaseSync {
	const sqlite = new DatabaseSync(':memory:');
	for (const filename of readdirSync(join(process.cwd(), 'migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
		sqlite.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
	}
	for (const id of ['intake-a', 'intake-b']) {
		sqlite.prepare(`INSERT INTO source_intakes (id,title,neutral_brief,significance_score,satire_potential_score,
			satire_suitability,editorial_notes,created_by_email,updated_by_email,created_at,updated_at)
			VALUES (?,?,'Brief',2,3,'SUITABLE','','editor@test','editor@test',?,?)`).run(id, id, NOW, NOW);
	}
	return sqlite;
}

const limits = (daily = 100, item = 100): ModelBudgetLimits => ({ enabled: true,
	operationMaxMicrousd: { NORMALIZE: 100, GENERATE_CANDIDATES: 100, GENERATE_ARTICLE_BODY: 100 },
	itemMaxMicrousd: item, dailyMaxMicrousd: daily });

function request(overrides: Partial<AdmitModelBudgetRecord> = {}): AdmitModelBudgetRecord {
	return { attemptKey: 'attempt-a', operation: 'NORMALIZE', sourceIntakeId: 'intake-a',
		normalizedEventVersionId: null, candidateId: null, owner: 'manual:editor', budgetDay: '2026-10-12',
		estimatedCostMicrousd: 6, limits: limits(), createdAt: NOW, ...overrides };
}

describe('atomic model budget admission', () => {
	it('admits only one concurrent request competing for the remaining daily budget', async () => {
		const sqlite = database(); const repository = new D1GenerationRepository(d1(sqlite));
		sqlite.exec(`INSERT INTO categories (id,slug,name,created_at) VALUES ('cat','cat','Category','${NOW}');
			INSERT INTO automation_runs (id,trigger_kind,status,started_at,completed_at) VALUES ('batch','SCHEDULED','SUCCEEDED','${NOW}','${NOW}');
			INSERT INTO editorial_batches (id,item_count,created_at) VALUES ('batch',1,'${NOW}');
			INSERT INTO editorial_batch_items (batch_id,source_intake_id,ordinal,category_id,workflow_state,
			selected_by_email,selected_at,lease_owner,lease_acquired_at,lease_expires_at,created_at,updated_at)
			VALUES ('batch','intake-b',1,'cat','GENERATING','editor@test','${NOW}','cron','${NOW}',
			'2026-10-12T12:10:00.000Z','${NOW}','${NOW}');`);
		const results = await Promise.all([
			repository.admitModelBudget(request({ attemptKey: 'manual', estimatedCostMicrousd: 6, limits: limits(10) })),
			repository.admitModelBudget(request({ attemptKey: 'scheduled', sourceIntakeId: 'intake-b', owner: 'cron',
				estimatedCostMicrousd: 6, limits: limits(10), workflowFence: { batchId: 'batch', intakeId: 'intake-b', leaseOwner: 'cron' } })),
		]);
		expect(results.sort()).toEqual(['ADMITTED', 'EXHAUSTED']);
		expect(sqlite.prepare('SELECT COUNT(*) count FROM model_budget_reservations').get()).toEqual({ count: 1 });
		sqlite.close();
	});

	it('reuses an identical attempt without double-counting it', async () => {
		const sqlite = database(); const repository = new D1GenerationRepository(d1(sqlite)); const record = request();
		expect(await repository.admitModelBudget(record)).toBe('ADMITTED');
		expect(await repository.admitModelBudget(record)).toBe('REUSED');
		expect(sqlite.prepare('SELECT SUM(estimated_cost_microusd) total FROM model_budget_reservations').get()).toEqual({ total: 6 });
		sqlite.close();
	});

	it('rejects an operation before reservation when its request ceiling is exceeded', async () => {
		const sqlite = database(); const repository = new D1GenerationRepository(d1(sqlite));
		const operationLimits = limits(); operationLimits.operationMaxMicrousd.NORMALIZE = 5;
		expect(await repository.admitModelBudget(request({ estimatedCostMicrousd: 6, limits: operationLimits }))).toBe('EXHAUSTED');
		expect(sqlite.prepare('SELECT COUNT(*) count FROM model_budget_reservations').get()).toEqual({ count: 0 });
		sqlite.close();
	});

	it('keeps ambiguous exposure reserved and releases only definitive rejected exposure', async () => {
		const sqlite = database(); const repository = new D1GenerationRepository(d1(sqlite));
		expect(await repository.admitModelBudget(request({ attemptKey: 'ambiguous', estimatedCostMicrousd: 7, limits: limits(10) }))).toBe('ADMITTED');
		expect(await repository.settleModelBudget({ attemptKey: 'ambiguous', owner: 'manual:editor', status: 'AMBIGUOUS',
			resolvedAt: NOW, resolutionReason: 'TIMEOUT' })).toBe(true);
		expect(await repository.admitModelBudget(request({ attemptKey: 'blocked', estimatedCostMicrousd: 4, limits: limits(10) }))).toBe('EXHAUSTED');
		expect(await repository.settleModelBudget({ attemptKey: 'ambiguous', owner: 'manual:editor', status: 'RELEASED',
			resolvedAt: NOW, resolutionReason: 'DEFINITIVE_REJECTION' })).toBe(true);
		expect(await repository.admitModelBudget(request({ attemptKey: 'released-capacity', estimatedCostMicrousd: 10, limits: limits(10) }))).toBe('ADMITTED');
		sqlite.close();
	});

	it('uses usage-derived cost for finalized exposure while leaving verified billing distinct', async () => {
		const sqlite = database(); const repository = new D1GenerationRepository(d1(sqlite));
		await repository.admitModelBudget(request({ estimatedCostMicrousd: 6, limits: limits(10) }));
		expect(await repository.settleModelBudget({ attemptKey: 'attempt-a', owner: 'manual:editor', status: 'FINALIZED',
			resolvedAt: NOW, usageRecordedCostMicrousd: 9, providerRequestId: 'req-1', resolutionReason: 'SUCCESS' })).toBe(true);
		expect(await repository.admitModelBudget(request({ attemptKey: 'over', sourceIntakeId: 'intake-b', estimatedCostMicrousd: 2, limits: limits(10) }))).toBe('EXHAUSTED');
		expect(sqlite.prepare(`SELECT estimated_cost_microusd,usage_recorded_cost_microusd,verified_billed_cost_microusd
			FROM model_budget_reservations WHERE attempt_key='attempt-a'`).get()).toEqual({
			estimated_cost_microusd: 6, usage_recorded_cost_microusd: 9, verified_billed_cost_microusd: null });
		sqlite.close();
	});

	it('applies item accumulation across normalization, candidates, and body', async () => {
		const sqlite = database(); const repository = new D1GenerationRepository(d1(sqlite));
		sqlite.exec(`INSERT INTO normalized_event_versions (id,source_intake_id,version_number,review_state,origin,event_statement,
			proposed_significance_score,proposed_satire_potential_score,proposed_suitability,suitability_reason,
			guardrail_flags_json,created_by_email,created_at) VALUES
			('version-a','intake-a',1,'ACCEPTED','EDITOR','Event',2,3,'SUITABLE','Reviewed','[]','editor@test','${NOW}');
			INSERT INTO categories (id,slug,name,created_at) VALUES ('cat','cat','Category','${NOW}');
			INSERT INTO satire_candidates (id,source_intake_id,proposed_headline,proposed_deck,draft_body_markdown,category_id,
			editorial_notes,status,created_by_email,updated_by_email,created_at,updated_at,normalized_event_version_id)
			VALUES ('candidate-a','intake-a','Headline','Deck','','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}','version-a');`);
		for (const record of [
			request({ attemptKey: 'normalize', estimatedCostMicrousd: 3, limits: limits(100, 10) }),
			request({ attemptKey: 'candidates', operation: 'GENERATE_CANDIDATES', normalizedEventVersionId: 'version-a', estimatedCostMicrousd: 3, limits: limits(100, 10) }),
		]) expect(await repository.admitModelBudget(record)).toBe('ADMITTED');
		expect(await repository.admitModelBudget(request({ attemptKey: 'body', operation: 'GENERATE_ARTICLE_BODY',
			normalizedEventVersionId: 'version-a', candidateId: 'candidate-a', estimatedCostMicrousd: 5,
			limits: limits(100, 10) }))).toBe('EXHAUSTED');
		sqlite.close();
	});

	it('does not reset the per-item ceiling when a later workflow batch uses the same intake', async () => {
		const sqlite = database(); const repository = new D1GenerationRepository(d1(sqlite));
		sqlite.exec(`INSERT INTO categories (id,slug,name,created_at) VALUES ('cat','cat','Category','${NOW}');
			INSERT INTO automation_runs (id,trigger_kind,status,started_at,completed_at) VALUES
			('batch-two','SCHEDULED','SUCCEEDED','${NOW}','${NOW}');
			INSERT INTO editorial_batches (id,item_count,created_at) VALUES ('batch-two',1,'${NOW}');
			INSERT INTO editorial_batch_items (batch_id,source_intake_id,ordinal,category_id,workflow_state,
			selected_by_email,selected_at,lease_owner,lease_acquired_at,lease_expires_at,created_at,updated_at) VALUES
			('batch-two','intake-a',1,'cat','GENERATING','editor@test','${NOW}','cron-two','${NOW}',
			'2026-10-12T12:10:00.000Z','${NOW}','${NOW}');`);
		expect(await repository.admitModelBudget(request({ attemptKey: 'prior-batch-attempt', owner: 'prior-worker',
			estimatedCostMicrousd: 6, limits: limits(100, 10) }))).toBe('ADMITTED');
		expect(await repository.admitModelBudget(request({ attemptKey: 'batch-two-attempt', owner: 'cron-two',
			estimatedCostMicrousd: 5, limits: limits(100, 10),
			workflowFence: { batchId: 'batch-two', intakeId: 'intake-a', leaseOwner: 'cron-two' } }))).toBe('EXHAUSTED');
		expect(sqlite.prepare('SELECT COUNT(*) count FROM model_budget_reservations').get()).toEqual({ count: 1 });
		sqlite.close();
	});

	it('retains pending exposure when a new repository instance resumes after restart', async () => {
		const sqlite = database();
		expect(await new D1GenerationRepository(d1(sqlite)).admitModelBudget(request({
			attemptKey: 'before-restart', estimatedCostMicrousd: 7, limits: limits(10),
		}))).toBe('ADMITTED');
		const recovered = new D1GenerationRepository(d1(sqlite));
		expect(await recovered.admitModelBudget(request({
			attemptKey: 'after-restart', estimatedCostMicrousd: 4, limits: limits(10),
		}))).toBe('EXHAUSTED');
		sqlite.close();
	});

	it('settles terminal exposure exactly once and rejects negative recorded costs', async () => {
		const sqlite = database(); const repository = new D1GenerationRepository(d1(sqlite));
		await repository.admitModelBudget(request({ estimatedCostMicrousd: 6, limits: limits(10) }));
		expect(await repository.settleModelBudget({ attemptKey: 'attempt-a', owner: 'manual:editor', status: 'FINALIZED',
			resolvedAt: NOW, usageRecordedCostMicrousd: 5, resolutionReason: 'SUCCESS' })).toBe(true);
		expect(await repository.settleModelBudget({ attemptKey: 'attempt-a', owner: 'manual:editor', status: 'RELEASED',
			resolvedAt: NOW, resolutionReason: 'DUPLICATE' })).toBe(false);
		expect(await repository.admitModelBudget(request({ attemptKey: 'negative-test', estimatedCostMicrousd: 1,
			limits: limits(10) }))).toBe('ADMITTED');
		await expect(repository.settleModelBudget({ attemptKey: 'negative-test', owner: 'manual:editor', status: 'FINALIZED',
			resolvedAt: NOW, usageRecordedCostMicrousd: -1, resolutionReason: 'INVALID' })).rejects.toThrow();
		expect(sqlite.prepare(`SELECT status,usage_recorded_cost_microusd FROM model_budget_reservations
			WHERE attempt_key='negative-test'`).get()).toEqual({ status: 'RESERVED', usage_recorded_cost_microusd: null });
		sqlite.close();
	});

	it('resets the daily ceiling only at the UTC budget-day boundary', async () => {
		const sqlite = database(); const repository = new D1GenerationRepository(d1(sqlite));
		expect(await repository.admitModelBudget(request({ attemptKey: 'day-one', estimatedCostMicrousd: 8, limits: limits(10) }))).toBe('ADMITTED');
		expect(await repository.admitModelBudget(request({ attemptKey: 'day-two', budgetDay: '2026-10-13',
			createdAt: '2026-10-13T00:00:00.000Z', estimatedCostMicrousd: 8, limits: limits(10) }))).toBe('ADMITTED');
		sqlite.close();
	});

	it('fails closed around unresolved historical attempts without accounting rows', async () => {
		const sqlite = database(); const repository = new D1GenerationRepository(d1(sqlite));
		sqlite.prepare(`INSERT INTO model_request_reservations (idempotency_key,operation,attempt_key,source_intake_id,
			owner,status,created_at) VALUES ('legacy','NORMALIZE','legacy-attempt','intake-a','old','PENDING',?)`).run(NOW);
		expect(await repository.admitModelBudget(request())).toBe('INCONSISTENT');
		expect(sqlite.prepare('SELECT COUNT(*) count FROM model_budget_reservations').get()).toEqual({ count: 0 });
		sqlite.close();
	});
});
