import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1RoutineBatchAdmissionRepository } from '../src/data/d1-routine-batch-admission-repository';
import { D1EditorialWorkflowRepository } from '../src/data/d1-editorial-workflow-repository';
import { D1EditorialReviewReminderRepository } from '../src/data/d1-editorial-review-reminder-repository';
import { RoutineBatchAdmissionService, routineOperatingDate } from '../src/services/routine-batch-admission-service';

const execute = Symbol('execute');
type ExecutableStatement = D1PreparedStatement & { [execute]: () => D1Result };

function d1Database(sqlite: DatabaseSync): D1Database {
	return { prepare(query: string) { let bindings: unknown[] = []; const statement = {
		bind(...values: unknown[]) { bindings = values; return statement; },
		async first<T>() { return (sqlite.prepare(query).get(...bindings as never[]) as T | undefined) ?? null; },
		async all<T>() { return { success: true, results: sqlite.prepare(query).all(...bindings as never[]) as T[] } as D1Result<T>; },
		async run<T>() { return statement[execute]() as D1Result<T>; },
		[execute]() { const result = sqlite.prepare(query).run(...bindings as never[]); return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result; },
	}; return statement as unknown as D1PreparedStatement; },
	async batch<T>(statements: D1PreparedStatement[]) { sqlite.exec('BEGIN IMMEDIATE'); try { const results = statements.map((statement) => (statement as ExecutableStatement)[execute]()); sqlite.exec('COMMIT'); return results as D1Result<T>[]; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } } as unknown as D1Database;
}

function database(): DatabaseSync {
	const sqlite = new DatabaseSync(':memory:');
	for (const filename of readdirSync(join(process.cwd(), 'migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
		sqlite.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
	}
	sqlite.exec("INSERT INTO categories (id,slug,name,created_at) VALUES ('cat','cat','Category','2026-10-13T12:00:00.000Z')");
	return sqlite;
}

function seedBatch(sqlite: DatabaseSync, batchId: string, createdAt: string, selected = 3, decideRemaining = true): void {
	sqlite.prepare(`INSERT INTO automation_runs (id,trigger_kind,status,started_at,completed_at)
		VALUES (?,'SCHEDULED','SUCCEEDED',?,?)`).run(batchId, createdAt, createdAt);
	sqlite.prepare('INSERT INTO editorial_batches (id,item_count,created_at) VALUES (?,3,?)').run(batchId, createdAt);
	for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
		const intakeId = `${batchId}-intake-${ordinal}`;
		sqlite.prepare(`INSERT INTO source_intakes (id,title,neutral_brief,significance_score,satire_potential_score,
			satire_suitability,editorial_notes,created_by_email,updated_by_email,created_at,updated_at)
			VALUES (?,?,?,1,1,'UNREVIEWED','','editor@tomorrow-ish.news','editor@tomorrow-ish.news',?,?)`)
			.run(intakeId, `Title ${ordinal}`, `Brief ${ordinal}`, createdAt, createdAt);
		const state = ordinal <= selected ? 'SELECTED' : decideRemaining ? 'REJECTED' : 'INGESTED';
		sqlite.prepare(`INSERT INTO editorial_batch_items (batch_id,source_intake_id,ordinal,category_id,workflow_state,
			selected_by_email,selected_at,rejected_by_email,rejected_at,created_at,updated_at) VALUES (?,?,?,'cat',?,?,?,?,?,?,?)`)
			.run(batchId, intakeId, ordinal, state,
				state === 'SELECTED' ? 'editor@tomorrow-ish.news' : null,
				state === 'SELECTED' ? createdAt : null,
				state === 'REJECTED' ? 'editor@tomorrow-ish.news' : null,
				state === 'REJECTED' ? createdAt : null, createdAt, createdAt);
		if (state === 'SELECTED') sqlite.prepare(`INSERT INTO editorial_workflow_events
			(id,batch_id,source_intake_id,event_kind,detail,created_at) VALUES (?,?,?,'INTAKE_SELECTED','routine-generation:v1',?)`)
			.run(`${batchId}-event-${ordinal}`, batchId, intakeId, createdAt);
		if (state === 'REJECTED') sqlite.prepare(`INSERT INTO editorial_workflow_events
			(id,batch_id,source_intake_id,event_kind,created_at) VALUES (?,?,?,'INTAKE_REJECTED',?)`)
			.run(`${batchId}-event-${ordinal}`, batchId, intakeId, createdAt);
	}
}

describe('routine generation batch admission', () => {
	it('uses America/New_York calendar boundaries', () => {
		expect(routineOperatingDate('2026-10-14T03:59:59.000Z')).toBe('2026-10-13');
		expect(routineOperatingDate('2026-10-14T04:00:00.000Z')).toBe('2026-10-14');
	});

	it('atomically admits one exact three-item batch and concurrent callers reuse it', async () => {
		const sqlite = database();
		seedBatch(sqlite, 'batch-a', '2026-10-13T12:00:00.000Z');
		seedBatch(sqlite, 'batch-b', '2026-10-13T13:00:00.000Z');
		const service = new RoutineBatchAdmissionService(
			new D1RoutineBatchAdmissionRepository(d1Database(sqlite)), '2026-10-13T00:00:00.000Z');
		const results = await Promise.all([
			service.admit('2026-10-13T14:00:00.000Z'), service.admit('2026-10-13T14:00:00.000Z'),
		]);
		expect(results).toEqual(['batch-a', 'batch-a']);
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM routine_generation_batch_admissions').get()).toEqual({ count: 1 });
		sqlite.prepare("UPDATE editorial_batch_items SET workflow_state='FAILED', failure_stage='BODY', failure_classification='TEST' WHERE batch_id='batch-a' AND ordinal=1").run();
		expect(await service.admit('2026-10-13T20:00:00.000Z')).toBe('batch-a');
		sqlite.close();
	});

	it('excludes historical, incomplete, and non-routine selections and fails closed on invalid activation boundaries', async () => {
		const sqlite = database();
		seedBatch(sqlite, 'historical', '2026-10-12T12:00:00.000Z');
		seedBatch(sqlite, 'incomplete', '2026-10-13T12:00:00.000Z', 2, false);
		const repository = new D1RoutineBatchAdmissionRepository(d1Database(sqlite));
		expect(() => new RoutineBatchAdmissionService(repository, undefined).admit('2026-10-13T15:00:00.000Z'))
			.toThrow(/explicit UTC timestamp/);
		expect(() => new RoutineBatchAdmissionService(repository, 'October 13').admit('2026-10-13T15:00:00.000Z'))
			.toThrow(/explicit UTC timestamp/);
		const service = new RoutineBatchAdmissionService(repository, '2026-10-13T00:00:00.000Z');
		expect(await service.admit('2026-10-13T15:00:00.000Z')).toBeNull();
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM routine_generation_batch_admissions').get()).toEqual({ count: 0 });
		sqlite.close();
	});

	it.each([1, 2, 3])('admits a fully triaged three-record batch with %i selected item(s)', async (selected) => {
		const sqlite = database();
		seedBatch(sqlite, `batch-${selected}`, '2026-10-13T12:00:00.000Z', selected);
		const service = new RoutineBatchAdmissionService(
			new D1RoutineBatchAdmissionRepository(d1Database(sqlite)), '2026-10-13T00:00:00.000Z');
		expect(await service.admit('2026-10-13T14:00:00.000Z')).toBe(`batch-${selected}`);
		expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM editorial_batch_items
			WHERE batch_id = ? AND workflow_state = 'REJECTED'`).get(`batch-${selected}`))
			.toEqual({ count: 3 - selected });
		sqlite.close();
	});

	it('fails closed when all three intake records are rejected', async () => {
		const sqlite = database();
		seedBatch(sqlite, 'batch-zero', '2026-10-13T12:00:00.000Z', 0);
		const service = new RoutineBatchAdmissionService(
			new D1RoutineBatchAdmissionRepository(d1Database(sqlite)), '2026-10-13T00:00:00.000Z');
		expect(await service.admit('2026-10-13T14:00:00.000Z')).toBeNull();
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM routine_generation_batch_admissions').get())
			.toEqual({ count: 0 });
		sqlite.close();
	});

	it('claims only the selected manifest and never a rejected intake', async () => {
		const sqlite = database();
		seedBatch(sqlite, 'batch-claims', '2026-10-13T12:00:00.000Z', 2);
		const db = d1Database(sqlite);
		const service = new RoutineBatchAdmissionService(
			new D1RoutineBatchAdmissionRepository(db), '2026-10-13T00:00:00.000Z');
		expect(await service.admit('2026-10-13T14:00:00.000Z')).toBe('batch-claims');
		const repository = new D1EditorialWorkflowRepository(db);
		const claimed = await repository.claimProcessable({
			limit: 3, owner: 'owner', at: '2026-10-13T14:00:00.000Z',
			leaseExpiresAt: '2026-10-13T14:10:00.000Z', createEventId: (() => { let id = 0; return () => `claim-${++id}`; })(),
			routineOnly: true, admittedBatchId: 'batch-claims',
		});
		expect(claimed.map((item) => item.intakeId)).toEqual(['batch-claims-intake-1', 'batch-claims-intake-2']);
		expect(sqlite.prepare("SELECT workflow_state FROM editorial_batch_items WHERE source_intake_id='batch-claims-intake-3'").get())
			.toEqual({ workflow_state: 'REJECTED' });
		sqlite.close();
	});

	it('creates final-review readiness once when every admitted selection is ready or terminally failed', async () => {
		const sqlite = database();
		seedBatch(sqlite, 'batch-ready', '2026-10-13T12:00:00.000Z', 2);
		const db = d1Database(sqlite);
		const admission = new RoutineBatchAdmissionService(
			new D1RoutineBatchAdmissionRepository(db), '2026-10-13T00:00:00.000Z');
		expect(await admission.admit('2026-10-13T12:30:00.000Z')).toBe('batch-ready');
		sqlite.exec(`UPDATE editorial_batch_items SET workflow_state='READY_FOR_REVIEW'
			WHERE batch_id='batch-ready' AND ordinal=1;
			UPDATE editorial_batch_items SET workflow_state='FAILED',failure_stage='BODY',failure_classification='TEST'
			WHERE batch_id='batch-ready' AND ordinal=2;
			INSERT INTO editorial_workflow_events (id,batch_id,source_intake_id,event_kind,created_at)
			VALUES ('ready-terminal','batch-ready','batch-ready-intake-1','ARTICLE_READY_FOR_REVIEW','2026-10-13T12:40:00.000Z');
			INSERT INTO editorial_workflow_events (id,batch_id,source_intake_id,event_kind,detail,created_at)
			VALUES ('failed-terminal','batch-ready','batch-ready-intake-2','GENERATION_FAILED','BODY:TEST','2026-10-13T12:45:00.000Z');`);
		const repository = new D1EditorialWorkflowRepository(db);
		expect(await repository.ensureFinalReminder('batch-ready', '2026-10-13T13:00:00.000Z', 'ready-event-1')).toBe(true);
		expect(await repository.ensureFinalReminder('batch-ready', '2026-10-13T13:05:00.000Z', 'ready-event-2')).toBe(false);
		expect(sqlite.prepare("SELECT COUNT(*) AS count FROM editorial_stage_reminders WHERE batch_id='batch-ready' AND stage='FINAL_REVIEW'").get()).toEqual({ count: 1 });
		expect(sqlite.prepare("SELECT detail FROM editorial_workflow_events WHERE batch_id='batch-ready' AND event_kind='FINAL_REVIEW_PHASE_CREATED'").get())
			.toEqual({ detail: 'selected=2;ready=1;failed=1' });
		expect(await new D1EditorialReviewReminderRepository(db).status('batch-ready', 'FINAL_REVIEW')).toEqual({
			pendingCount: 1, selectedCount: 2, readyCount: 1, failedCount: 1,
			generationSettled: true, routineAdmission: true,
		});
		sqlite.close();
	});
});
