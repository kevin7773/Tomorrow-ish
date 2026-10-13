import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1ArticleImageRepository } from '../src/data/d1-article-image-repository';
import type { RecordPendingImageGeneration } from '../src/data/article-image-repository';
import { routineImagePreparationConfig } from '../src/images/routine-image-config';

const NOW = '2026-10-13T12:00:00.000Z';
const execute = Symbol('execute');
type Executable = D1PreparedStatement & { [execute]: () => D1Result };

function d1(sqlite: DatabaseSync): D1Database {
	return { prepare(query: string) { let values: unknown[] = []; const statement = {
		bind(...bindings: unknown[]) { values = bindings; return statement; },
		async first<T>() { return (sqlite.prepare(query).get(...values as never[]) as T | undefined) ?? null; },
		async all<T>() { return { success: true, results: sqlite.prepare(query).all(...values as never[]) as T[] } as D1Result<T>; },
		async run<T>() { return statement[execute]() as D1Result<T>; },
		[execute]() { const result = sqlite.prepare(query).run(...values as never[]); return {
			success: true, results: [], meta: { changes: Number(result.changes) },
		} as unknown as D1Result; },
	}; return statement as unknown as D1PreparedStatement; },
	async batch<T>(statements: D1PreparedStatement[]) { sqlite.exec('BEGIN IMMEDIATE'); try {
		const results = statements.map((statement) => (statement as Executable)[execute]());
		sqlite.exec('COMMIT'); return results as D1Result<T>[];
	} catch (error) { sqlite.exec('ROLLBACK'); throw error; } } } as unknown as D1Database;
}

function fixture(): { sqlite: DatabaseSync; repository: D1ArticleImageRepository } {
	const sqlite = new DatabaseSync(':memory:');
	for (const filename of readdirSync(join(process.cwd(), 'migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
		sqlite.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
	}
	sqlite.exec(`INSERT INTO categories (id,slug,name,created_at) VALUES ('cat','cat','Category','${NOW}');
		INSERT INTO automation_runs (id,trigger_kind,status,started_at,completed_at)
		VALUES ('batch','SCHEDULED','SUCCEEDED','${NOW}','${NOW}');
		INSERT INTO editorial_batches (id,item_count,created_at) VALUES ('batch',3,'${NOW}');`);
	for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
		sqlite.exec(`INSERT INTO source_intakes (id,title,neutral_brief,significance_score,satire_potential_score,
			satire_suitability,editorial_notes,created_by_email,updated_by_email,created_at,updated_at)
			VALUES ('intake-${ordinal}','Title','Brief',3,3,'SUITABLE','','automation@test','automation@test','${NOW}','${NOW}');
			INSERT INTO stories (id,slug,headline,deck,body_markdown,edition_date,category_id,status,social_excerpt,created_at,updated_at)
			VALUES ('story-${ordinal}','story-${ordinal}','Headline','Deck','Body','2026-10-13','cat','REVIEW','Excerpt','${NOW}','${NOW}');
			INSERT INTO editorial_batch_items (batch_id,source_intake_id,ordinal,category_id,workflow_state,
				selected_by_email,selected_at,story_id,lease_owner,lease_acquired_at,lease_expires_at,created_at,updated_at)
			VALUES ('batch','intake-${ordinal}',${ordinal},'cat','GENERATING','automation@test','${NOW}',
				'story-${ordinal}','worker','${NOW}','2026-10-13T12:10:00.000Z','${NOW}','${NOW}');`);
		sqlite.prepare(`INSERT INTO editorial_workflow_events
			(id,batch_id,source_intake_id,event_kind,detail,created_at)
			VALUES (?,?,?,'INTAKE_SELECTED','routine-generation:v1',?)`)
			.run(`selected-${ordinal}`, 'batch', `intake-${ordinal}`, NOW);
	}
	sqlite.exec(`INSERT INTO routine_generation_batch_admissions
		(operating_date,time_zone,batch_id,actor_email,admitted_at)
		VALUES ('2026-10-13','America/New_York','batch','automation@test','${NOW}');`);
	return { sqlite, repository: new D1ArticleImageRepository(d1(sqlite)) };
}

function pending(ordinal: number, cost = 50_000, overrides: Partial<RecordPendingImageGeneration> = {}): RecordPendingImageGeneration {
	return {
		id: `image-${ordinal}`, storyId: `story-${ordinal}`, provider: 'provider', model: 'model',
		prompt: `Assembled safe prompt for story ${ordinal}`, visualDirection: `Specific visual direction for story ${ordinal}.`,
		promptVersion: 'article-image-v2', aspectRatio: '3:2', altText: `Proposed alt ${ordinal}`,
		attemptKey: `routine-image:v1:batch:intake-${ordinal}:story-${ordinal}`,
		estimatedCostMicrousd: cost, pricingBasis: { reviewed: true }, requestedByEmail: 'automation@test',
		requestedAt: NOW, auditId: `audit-${ordinal}`,
		routine: { batchId: 'batch', intakeId: `intake-${ordinal}`, leaseOwner: 'worker',
			attemptMaxMicrousd: 50_000, batchMaxMicrousd: 150_000, dailyMaxMicrousd: 150_000 },
		...overrides,
	};
}

describe('governed routine image preparation', () => {
	it('is default-false and requires the exact reviewed ceilings before activation', () => {
		expect(routineImagePreparationConfig({})).toEqual({ enabled: false,
			attemptMaxMicrousd: 0, batchMaxMicrousd: 0, dailyMaxMicrousd: 0 });
		expect(routineImagePreparationConfig({ EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED: 'true',
			IMAGE_ATTEMPT_BUDGET_MICRO_USD: '50000', IMAGE_BATCH_BUDGET_MICRO_USD: '150000',
			IMAGE_DAILY_BUDGET_MICRO_USD: '150000' })).toMatchObject({ enabled: true });
		expect(() => routineImagePreparationConfig({ EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED: 'true',
			IMAGE_ATTEMPT_BUDGET_MICRO_USD: '50000', IMAGE_BATCH_BUDGET_MICRO_USD: '150001',
			IMAGE_DAILY_BUDGET_MICRO_USD: '150000' })).toThrow(/exactly/);
	});

	it('atomically reserves one durable attempt per admitted story and persists prompt evidence', async () => {
		const { sqlite, repository } = fixture();
		const results = await Promise.all([repository.recordPending(pending(1)), repository.recordPending(pending(1, 50_000, {
			id: 'image-concurrent', auditId: 'audit-concurrent',
		}))]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(sqlite.prepare(`SELECT visual_direction,prompt,workflow_batch_id,workflow_intake_id,
			budget_operating_date,automation_scope FROM article_images`).get()).toEqual({
			visual_direction: 'Specific visual direction for story 1.',
			prompt: 'Assembled safe prompt for story 1', workflow_batch_id: 'batch',
			workflow_intake_id: 'intake-1', budget_operating_date: '2026-10-13',
			automation_scope: 'ROUTINE_IMAGE_PREPARATION_V1',
		});
		expect(await repository.markPendingAmbiguous({ imageId: 'image-1', providerRequestId: null,
			metadata: { outcome: 'unknown' }, errorClassification: 'PROVIDER_TIMEOUT',
			errorMessage: 'Unknown.', at: NOW, auditId: 'ambiguous-1' })).toBe(true);
		expect(await repository.recordPending(pending(1, 50_000, { id: 'replay', auditId: 'audit-replay' }))).toBe(false);
		sqlite.close();
	});

	it('contains atomic batch and daily image exposure and rejects wrong admission identity', async () => {
		const { sqlite, repository } = fixture();
		expect(await repository.recordPending(pending(4, 1, { routine: {
			batchId: 'batch', intakeId: 'intake-4', leaseOwner: 'stale-worker',
			attemptMaxMicrousd: 50_000, batchMaxMicrousd: 150_000, dailyMaxMicrousd: 150_000,
		} }))).toBe(false);
		expect((await Promise.all([repository.recordPending(pending(1)), repository.recordPending(pending(2)),
			repository.recordPending(pending(3))])).filter(Boolean)).toHaveLength(3);
		expect(await repository.recordPending(pending(4, 1))).toBe(false);
		expect(sqlite.prepare('SELECT SUM(estimated_cost_microusd) AS total FROM article_images').get())
			.toEqual({ total: 150_000 });
		sqlite.close();
	});
});
