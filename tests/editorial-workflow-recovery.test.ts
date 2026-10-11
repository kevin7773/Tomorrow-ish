import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { D1EditorialCronWindowRepository } from '../src/data/d1-editorial-cron-window-repository';
import { D1EditorialWorkflowRepository } from '../src/data/d1-editorial-workflow-repository';
import { fiveMinuteWindow, runDeduplicatedCronWindow } from '../src/services/editorial-cron-window';

const NOW = '2026-10-11T12:00:00.000Z';
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
	sqlite.exec(`INSERT INTO categories (id,slug,name,created_at) VALUES ('cat','cat','Category','${NOW}');
		INSERT INTO automation_runs (id,trigger_kind,status,started_at,completed_at) VALUES ('batch','SCHEDULED','SUCCEEDED','${NOW}','${NOW}');
		INSERT INTO editorial_batches (id,item_count,created_at) VALUES ('batch',10,'${NOW}');`);
	return sqlite;
}

function intake(sqlite: DatabaseSync, id: string): void {
	sqlite.prepare(`INSERT INTO source_intakes (id,title,neutral_brief,significance_score,satire_potential_score,
		satire_suitability,editorial_notes,created_by_email,updated_by_email,created_at,updated_at)
		VALUES (?,?,'Neutral brief',2,3,'SUITABLE','','editor@test','editor@test',?,?)`).run(id, id, NOW, NOW);
}

function batchItem(sqlite: DatabaseSync, id: string, ordinal: number, state = 'SELECTED'): void {
	intake(sqlite, id);
	sqlite.prepare(`INSERT INTO editorial_batch_items (batch_id,source_intake_id,ordinal,category_id,workflow_state,
		selected_by_email,selected_at,created_at,updated_at) VALUES ('batch',?,?,'cat',?,'editor@test',?,?,?)`)
		.run(id, ordinal, state === 'FAILED' ? 'SELECTED' : state, NOW, NOW, NOW);
	if (state === 'FAILED') sqlite.prepare(`UPDATE editorial_batch_items SET workflow_state='FAILED',
		failure_stage='MODEL',failure_classification='MALFORMED_OUTPUT' WHERE source_intake_id=?`).run(id);
}

describe('editorial workflow recovery primitives', () => {
	it('atomically leases one item to only one concurrent processor', async () => {
		const sqlite = database(); batchItem(sqlite, 'intake-1', 1); const repository = new D1EditorialWorkflowRepository(d1(sqlite));
		const claim = (owner: string) => repository.claimProcessable({ limit: 1, owner, at: NOW,
			leaseExpiresAt: '2026-10-11T12:10:00.000Z', createEventId: () => `event-${owner}` });
		const [first, second] = await Promise.all([claim('worker-a'), claim('worker-b')]);
		expect(first.length + second.length).toBe(1);
		expect(sqlite.prepare('SELECT lease_owner,attempt_count FROM editorial_batch_items').get())
			.toMatchObject({ attempt_count: 1 });
		sqlite.close();
	});

	it('recovers an expired lease and does not let an active blocked row starve selected work', async () => {
		const sqlite = database(); batchItem(sqlite, 'stale', 1, 'GENERATING'); batchItem(sqlite, 'blocked', 2, 'GENERATING'); batchItem(sqlite, 'fresh', 3);
		sqlite.prepare(`UPDATE editorial_batch_items SET lease_owner='old',lease_acquired_at=?,lease_expires_at=?,attempt_count=1 WHERE source_intake_id='stale'`)
			.run('2026-10-11T11:40:00.000Z', '2026-10-11T11:50:00.000Z');
		sqlite.prepare(`UPDATE editorial_batch_items SET lease_owner='active',lease_acquired_at=?,lease_expires_at=? WHERE source_intake_id='blocked'`)
			.run(NOW, '2026-10-11T12:10:00.000Z');
		const repository = new D1EditorialWorkflowRepository(d1(sqlite));
		const claimed = await repository.claimProcessable({ limit: 2, owner: 'restart', at: NOW,
			leaseExpiresAt: '2026-10-11T12:10:00.000Z', createEventId: () => crypto.randomUUID() });
		expect(claimed.map((item) => item.intakeId)).toEqual(['fresh', 'stale']);
		expect(claimed.map((item) => item.attemptCount)).toEqual([1, 2]);
		expect(sqlite.prepare("SELECT lease_owner FROM editorial_batch_items WHERE source_intake_id='blocked'").get()).toEqual({ lease_owner: 'active' });
		sqlite.close();
	});

	it('reconciles a published story found through origin_candidate_id with APPROVED image evidence', async () => {
		const sqlite = database(); batchItem(sqlite, 'intake-1', 1, 'GENERATING');
		sqlite.exec(`INSERT INTO satire_candidates (id,source_intake_id,proposed_headline,proposed_deck,draft_body_markdown,category_id,editorial_notes,status,created_by_email,updated_by_email,created_at,updated_at)
			VALUES ('candidate','intake-1','Headline','Deck','Body','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}');
			UPDATE editorial_batch_items SET candidate_id='candidate' WHERE source_intake_id='intake-1';
			INSERT INTO stories (id,slug,headline,deck,body_markdown,edition_date,published_at,category_id,status,social_excerpt,og_image_key,tags_json,created_at,updated_at,origin_candidate_id)
			VALUES ('story','story','Headline','Deck','Body','2026-10-10','${NOW}','cat','PUBLISHED','Deck','image-key','[]','${NOW}','${NOW}','candidate');
			INSERT INTO article_images (id,story_id,provider,model,prompt,prompt_version,aspect_ratio,asset_key,content_type,byte_size,status,alt_text,metadata_json,requested_by_email,requested_at,generated_at,reviewed_by_email,reviewed_at)
			VALUES ('image','story','test','test','prompt','v1','1:1','image-key','image/png',10,'APPROVED','Alt','{}','editor@test','${NOW}','${NOW}','editor@test','${NOW}');`);
		const repository = new D1EditorialWorkflowRepository(d1(sqlite)); let id = 0;
		expect(await repository.reconcilePublished({ limit: 50, actorEmail: 'automation@test', at: NOW,
			createEventId: () => `event-${++id}`, createAuditId: () => `audit-${++id}` })).toBe(1);
		expect(await repository.findItem('batch', 'intake-1')).toMatchObject({ state: 'PUBLISHED', storyId: 'story' });
		expect(sqlite.prepare("SELECT COUNT(*) count FROM editorial_workflow_events WHERE event_kind='WORKFLOW_PUBLISHED_RECONCILED'").get()).toEqual({ count: 1 });
		expect(await repository.reconcilePublished({ limit: 50, actorEmail: 'automation@test', at: NOW,
			createEventId: () => `event-${++id}`, createAuditId: () => `audit-${++id}` })).toBe(0);
		sqlite.close();
	});

	it('records explicit retry attempts and unique attempt keys', async () => {
		const sqlite = database(); batchItem(sqlite, 'intake-1', 1, 'FAILED');
		const repository = new D1EditorialWorkflowRepository(d1(sqlite));
		expect(await repository.retryFailed('batch', 'intake-1', 'editor@test', NOW, 'retry-event')).toBe(true);
		expect(await repository.findItem('batch', 'intake-1')).toMatchObject({ state: 'SELECTED', retryAttempt: 1 });
		expect(sqlite.prepare("SELECT detail FROM editorial_workflow_events WHERE id='retry-event'").get())
			.toEqual({ detail: 'editor@test;attempt=1;key=workflow-retry:v1:batch:intake-1:1' });
		sqlite.close();
	});

	it('accepts APPROVED image evidence when completing a leased review package', async () => {
		const sqlite = database(); batchItem(sqlite, 'intake-1', 1, 'GENERATING');
		sqlite.exec(`INSERT INTO satire_candidates (id,source_intake_id,proposed_headline,proposed_deck,draft_body_markdown,category_id,editorial_notes,status,created_by_email,updated_by_email,created_at,updated_at)
			VALUES ('candidate','intake-1','Headline','Deck','Body','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}');
			INSERT INTO stories (id,slug,headline,deck,body_markdown,edition_date,category_id,status,social_excerpt,tags_json,created_at,updated_at,origin_candidate_id)
			VALUES ('story','review-story','Headline','Deck','Body','2026-10-11','cat','REVIEW','Deck','[]','${NOW}','${NOW}','candidate');
			INSERT INTO article_images (id,story_id,provider,model,prompt,prompt_version,aspect_ratio,asset_key,content_type,byte_size,status,alt_text,metadata_json,requested_by_email,requested_at,generated_at,reviewed_by_email,reviewed_at)
			VALUES ('image','story','test','test','prompt','v1','1:1','approved-key','image/png',10,'APPROVED','Alt','{}','editor@test','${NOW}','${NOW}','editor@test','${NOW}');
			UPDATE editorial_batch_items SET candidate_id='candidate',lease_owner='worker',lease_acquired_at='${NOW}',lease_expires_at='2026-10-11T12:10:00.000Z' WHERE source_intake_id='intake-1';`);
		const repository = new D1EditorialWorkflowRepository(d1(sqlite));
		expect(await repository.attachExistingStory({ batchId: 'batch', intakeId: 'intake-1', candidateId: 'candidate',
			storyId: 'story', owner: 'worker', at: NOW, eventId: 'attach-event' })).toBe(true);
		expect(await repository.markReady('batch', 'intake-1', 'story', 'worker', NOW, 'ready-event')).toBe(true);
		expect(await repository.findItem('batch', 'intake-1')).toMatchObject({ state: 'READY_FOR_REVIEW', leaseOwner: null });
		sqlite.close();
	});
});

describe('five-minute cron windows', () => {
	it('deduplicates concurrent invocations in the same scheduled window', async () => {
		const sqlite = database(); const repository = new D1EditorialCronWindowRepository(d1(sqlite)); const work = vi.fn(async () => undefined);
		const record = { cron: '*/5 * * * *', scheduledTime: Date.parse('2026-10-11T12:02:38Z'), at: NOW };
		const results = await Promise.all([
			runDeduplicatedCronWindow(repository, { ...record, owner: 'a' }, work),
			runDeduplicatedCronWindow(repository, { ...record, owner: 'b' }, work),
		]);
		expect(results.sort()).toEqual(['COMPLETED', 'DUPLICATE']); expect(work).toHaveBeenCalledTimes(1);
		expect(fiveMinuteWindow(record.cron, record.scheduledTime).startedAt).toBe('2026-10-11T12:00:00.000Z');
		sqlite.close();
	});

	it('recovers a crashed cron owner only after its lease expires', async () => {
		const sqlite = database(); const repository = new D1EditorialCronWindowRepository(d1(sqlite));
		const window = fiveMinuteWindow('*/5 * * * *', Date.parse('2026-10-11T12:02:00Z'));
		expect(await repository.claim({ key: window.key, cron: '*/5 * * * *', windowStartedAt: window.startedAt,
			owner: 'crashed', at: '2026-10-11T11:50:00.000Z', leaseExpiresAt: '2026-10-11T11:54:00.000Z' })).toBe(true);
		expect(await repository.claim({ key: window.key, cron: '*/5 * * * *', windowStartedAt: window.startedAt,
			owner: 'restart', at: NOW, leaseExpiresAt: '2026-10-11T12:04:00.000Z' })).toBe(true);
		expect(sqlite.prepare('SELECT owner,attempt_count FROM editorial_cron_windows').get()).toEqual({ owner: 'restart', attempt_count: 2 });
		sqlite.close();
	});
});
