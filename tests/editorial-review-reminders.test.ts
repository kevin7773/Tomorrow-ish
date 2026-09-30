import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { D1AutomationRepository } from '../src/data/d1-automation-repository';
import { D1EditorialReviewReminderRepository } from '../src/data/d1-editorial-review-reminder-repository';
import { D1EditorialWorkflowRepository } from '../src/data/d1-editorial-workflow-repository';
import type { ReviewReminderRepository } from '../src/data/editorial-review-reminder-repository';
import type { ClaimedReviewReminder, EditorialReminderStage, ReviewReminderBatch } from '../src/domain/editorial-review-reminder';
import { InternalReviewNotifier, ReviewNotificationError, type ReviewNotification, type ReviewNotifier } from '../src/notifications/review-notifier';
import { EditorialReviewReminderService } from '../src/services/editorial-review-reminder-service';
import type { ReviewNotificationReceiverService } from '../src/services/review-notification-receiver-service';

const START = new Date('2026-09-27T12:00:00.000Z');
const execute = Symbol('execute');
type ExecutableStatement = D1PreparedStatement & { [execute]: () => D1Result };

function reminder(stage: EditorialReminderStage, overrides: Partial<ReviewReminderBatch> = {}): ReviewReminderBatch {
	return { batchId: 'batch-1', stage, itemCount: 3, createdAt: START.toISOString(),
		initialSentAt: null, sixHourSentAt: null, finalSentAt: null, resolvedAt: null, ...overrides };
}

function harness(stage: EditorialReminderStage, pending = 3, now = START, fail = false) {
	let stored = reminder(stage); let count = pending; let clock = now; let claim: ClaimedReviewReminder | null = null;
	const sent: ReviewNotification[] = [];
	const repository: ReviewReminderRepository = {
		listUnresolved: vi.fn(async () => stored.resolvedAt ? [] : [{ ...stored }]),
		countPending: vi.fn(async () => count),
		resolve: vi.fn(async (_batchId, _stage, at) => { if (count !== 0) return false; stored = { ...stored, resolvedAt: at }; return true; }),
		claim: vi.fn(async (batchId, claimedStage, kind, claimToken) => {
			if (claim) return null; claim = { batchId, stage: claimedStage, kind, claimToken }; return claim;
		}),
		complete: vi.fn(async (completed, at) => {
			if (claim?.claimToken !== completed.claimToken) return false;
			if (completed.kind === 'INITIAL') stored = { ...stored, initialSentAt: at };
			if (completed.kind === 'SIX_HOUR') stored = { ...stored, sixHourSentAt: at };
			if (completed.kind === 'FINAL') stored = { ...stored, finalSentAt: at };
			claim = null; return true;
		}),
		releaseFailed: vi.fn(async () => { claim = null; }),
	};
	const notifier: ReviewNotifier = { send: vi.fn(async (notification) => {
		if (fail) throw new ReviewNotificationError('NETWORK'); sent.push(notification);
	}) };
	let id = 0;
	const service = new EditorialReviewReminderService(repository, notifier, 'https://example.test/editorial/batches', {
		now: () => clock, createId: () => `id-${++id}`,
	});
	return { service, repository, sent, get: () => stored, setPending: (value: number) => { count = value; }, setNow: (value: Date) => { clock = value; } };
}

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

function database(seedReminder = true): DatabaseSync {
	const sqlite = new DatabaseSync(':memory:');
	for (const filename of readdirSync(join(process.cwd(), 'migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
	if (seedReminder) sqlite.exec(`INSERT INTO automation_runs (id, trigger_kind, status, started_at, completed_at) VALUES ('batch-1','SCHEDULED','SUCCEEDED','${START.toISOString()}','${START.toISOString()}');
		INSERT INTO editorial_batches (id,item_count,created_at) VALUES ('batch-1',3,'${START.toISOString()}');
		INSERT INTO editorial_stage_reminders (batch_id,stage,created_at) VALUES ('batch-1','TRIAGE','${START.toISOString()}');`);
	return sqlite;
}

describe('two-phase editorial reminders', () => {
	it('groups three newly ingested items into one durable intake-triage batch', async () => {
		const sqlite = database(false);
		const at = START.toISOString();
		sqlite.exec(`INSERT INTO categories (id,slug,name,created_at) VALUES ('cat-civic-life','civic-life','Civic Life','${at}');
			INSERT INTO automation_runs (id,trigger_kind,status,started_at) VALUES ('batch-1','SCHEDULED','RUNNING','${at}');`);
		for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
			sqlite.prepare(`INSERT INTO source_intakes (id,title,neutral_brief,significance_score,satire_potential_score,satire_suitability,editorial_notes,created_by_email,updated_by_email,created_at,updated_at)
				VALUES (?,?,?,?,?,'UNREVIEWED','','automation@tomorrow-ish.news','automation@tomorrow-ish.news',?,?)`)
				.run(`intake-${ordinal}`, `Intake ${ordinal}`, `Brief ${ordinal}`, 1, 1, at, at);
			sqlite.prepare(`INSERT INTO automation_sources (item_identity,source_url,source_intake_id,category_id,first_seen_at,last_seen_at)
				VALUES (?,?,?,?,?,?)`).run(`identity-${ordinal}`, `https://example.test/${ordinal}`, `intake-${ordinal}`, 'cat-civic-life', at, at);
		}
		const db = d1Database(sqlite);
		const repository = new D1AutomationRepository(db);
		for (let ordinal = 1; ordinal <= 3; ordinal += 1) await repository.recordItem('batch-1', ordinal, {
			itemIdentity: `identity-${ordinal}`, sourceUrl: `https://example.test/${ordinal}`,
			outcome: 'INTAKE_CREATED', reason: 'CREATED', sourceIntakeId: `intake-${ordinal}`,
			normalizedEventVersionId: null, modelRunId: null,
		}, at);
		expect(sqlite.prepare('SELECT item_count FROM editorial_batches WHERE id = ?').get('batch-1')).toEqual({ item_count: 3 });
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM editorial_batch_items WHERE batch_id = ?').get('batch-1')).toEqual({ count: 3 });
		expect(sqlite.prepare("SELECT COUNT(*) AS count FROM editorial_stage_reminders WHERE batch_id = ? AND stage = 'TRIAGE'").get('batch-1')).toEqual({ count: 1 });
		expect(sqlite.prepare("SELECT COUNT(*) AS count FROM editorial_workflow_events WHERE batch_id = ? AND event_kind = 'BATCH_CREATED'").get('batch-1')).toEqual({ count: 1 });

		const workflow = new D1EditorialWorkflowRepository(db);
		expect(await workflow.select('batch-1', 'intake-1', 'editor@tomorrow-ish.news', at, 'selected-1')).toBe(true);
		const restarted = new D1EditorialWorkflowRepository(db);
		expect(await restarted.findItem('batch-1', 'intake-1')).toMatchObject({ state: 'SELECTED' });
		const reminders = new D1EditorialReviewReminderRepository(db);
		expect(await reminders.countPending('batch-1', 'TRIAGE')).toBe(2);
		expect(await restarted.rejectIntake('batch-1', 'intake-2', 'editor@tomorrow-ish.news', at, 'rejected-2')).toBe(true);
		expect(await restarted.rejectIntake('batch-1', 'intake-3', 'editor@tomorrow-ish.news', at, 'rejected-3')).toBe(true);
		expect(await reminders.countPending('batch-1', 'TRIAGE')).toBe(0);
		sqlite.close();
	});

	it('sends one intake-triage initial reminder for a three-item batch and deduplicates retries', async () => {
		const test = harness('TRIAGE'); await test.service.process(); await test.service.process();
		expect(test.sent).toHaveLength(1);
		expect(test.sent[0]).toMatchObject({ stage: 'TRIAGE', kind: 'INITIAL', message: '📰 Tomorrow-ish has 3 new intakes ready for editorial triage.', idempotencyKey: 'editorial-review:batch-1:TRIAGE:INITIAL' });
	});

	it('keeps partial triage pending and resolves only after every intake is decided', async () => {
		const test = harness('TRIAGE', 1); await test.service.process();
		expect(test.get().resolvedAt).toBeNull(); test.setPending(0); await test.service.process();
		expect(test.get().resolvedAt).toBe(START.toISOString());
	});

	it('uses independent initial, six-hour, and final schedules for final review', async () => {
		const intake = harness('TRIAGE'); await intake.service.process();
		const final = harness('FINAL_REVIEW'); await final.service.process();
		final.setNow(new Date(START.getTime() + 6 * 60 * 60 * 1000)); await final.service.process();
		final.setNow(new Date(START.getTime() + 24 * 60 * 60 * 1000)); await final.service.process();
		expect(final.sent.map(({ kind }) => kind)).toEqual(['INITIAL', 'SIX_HOUR', 'FINAL']);
		expect(final.sent[0].idempotencyKey).toContain(':FINAL_REVIEW:');
		expect(intake.sent[0].idempotencyKey).toContain(':TRIAGE:');
	});

	it('keeps final review pending through edits or image regeneration until publish/reject removes every ready item', async () => {
		const test = harness('FINAL_REVIEW', 2); await test.service.process();
		test.setPending(2); await test.service.process(); expect(test.get().resolvedAt).toBeNull();
		test.setPending(1); await test.service.process(); expect(test.get().resolvedAt).toBeNull();
		test.setPending(0); await test.service.process(); expect(test.get().resolvedAt).not.toBeNull();
	});

	it('isolates notification failure from durable workflow state', async () => {
		const test = harness('TRIAGE', 3, START, true);
		expect(await test.service.process()).toMatchObject({ failed: 1, sent: 0 });
		expect(test.get()).toMatchObject({ initialSentAt: null, resolvedAt: null });
		expect(test.repository.releaseFailed).toHaveBeenCalledTimes(1);
	});

	it('continues processing other eligible batches after one notification delivery fails', async () => {
		const batches = [
			reminder('TRIAGE', { batchId: 'batch-fails' }),
			reminder('FINAL_REVIEW', { batchId: 'batch-succeeds' }),
		];
		const completed: string[] = [];
		const released: string[] = [];
		const repository: ReviewReminderRepository = {
			listUnresolved: vi.fn(async () => batches),
			countPending: vi.fn(async () => 1),
			resolve: vi.fn(async () => false),
			claim: vi.fn(async (batchId, stage, kind, claimToken) => ({ batchId, stage, kind, claimToken })),
			complete: vi.fn(async (claim) => { completed.push(claim.batchId); return true; }),
			releaseFailed: vi.fn(async (claim) => { released.push(claim.batchId); }),
		};
		const receiver: Pick<ReviewNotificationReceiverService, 'receive'> = {
			receive: vi.fn(async (notification) => notification.batchId === 'batch-fails' ? 'delivery-failed' : 'accepted'),
		};
		const notifier = new InternalReviewNotifier(receiver, 'https://example.test');
		const service = new EditorialReviewReminderService(repository, notifier, null, {
			now: () => START,
			createId: (() => { let id = 0; return () => `id-${++id}`; })(),
		});

		expect(await service.process()).toEqual({ resolved: 0, sent: 1, failed: 1 });
		expect(released).toEqual(['batch-fails']);
		expect(completed).toEqual(['batch-succeeds']);
		expect(receiver.receive).toHaveBeenCalledTimes(2);
	});

	it('persists claims and sent state in D1 across service restarts', async () => {
		const sqlite = database();
		const db = d1Database(sqlite);
		const repository = new D1EditorialReviewReminderRepository(db);
		const claim = await repository.claim('batch-1', 'TRIAGE', 'INITIAL', 'claim-1', START.toISOString(), new Date(START.getTime() - 600_000).toISOString());
		expect(claim).not.toBeNull();
		await repository.complete(claim!, START.toISOString(), 'sent-1');
		const restarted = new D1EditorialReviewReminderRepository(db);
		expect((await restarted.listUnresolved(10))[0]).toMatchObject({ stage: 'TRIAGE', initialSentAt: START.toISOString() });
		expect(await restarted.claim('batch-1', 'TRIAGE', 'INITIAL', 'claim-2', START.toISOString(), new Date(START.getTime() - 600_000).toISOString())).toBeNull();
		sqlite.close();
	});

	it('contains no candidate-state reminder semantics', () => {
		const source = readFileSync(join(process.cwd(), 'src/data/d1-editorial-review-reminder-repository.ts'), 'utf8');
		expect(source).not.toContain("status IN ('DRAFT', 'REVIEW')");
		expect(source).toContain("workflow_state = 'INGESTED'");
		expect(source).toContain("workflow_state = 'READY_FOR_REVIEW'");
	});

	it('keeps reminder processing free of generation, approval, rejection, and publication authority', () => {
		const runtime = readFileSync(join(process.cwd(), 'src/reminders/runtime-editorial-review-reminders.ts'), 'utf8');
		const service = readFileSync(join(process.cwd(), 'src/services/editorial-review-reminder-service.ts'), 'utf8');
		for (const source of [runtime, service]) {
			expect(source).not.toContain('GenerationService');
			expect(source).not.toContain('runEditorialWorkflow');
			expect(source).not.toContain('publishFinal');
			expect(source).not.toContain('approveLatestGenerated');
			expect(source).not.toContain('rejectFinal');
		}
		expect(runtime).toContain('InternalReviewNotifier');
		expect(runtime).not.toContain('WebhookReviewNotifier');
		expect(runtime).not.toContain('fetch(');
	});
});
