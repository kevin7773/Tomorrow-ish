import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { D1EditorialCronWindowRepository } from '../src/data/d1-editorial-cron-window-repository';
import { D1EditorialRepository } from '../src/data/d1-editorial-repository';
import { D1EditorialWorkflowRepository } from '../src/data/d1-editorial-workflow-repository';
import { D1GenerationRepository } from '../src/data/d1-generation-repository';
import { fiveMinuteWindow, runDeduplicatedCronWindow } from '../src/services/editorial-cron-window';
import { SMOKE_BATCH_ID, SMOKE_INTAKE_ID } from '../src/services/editorial-smoke-target';

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

function smokeBatchItem(sqlite: DatabaseSync, state = 'GENERATING'): void {
	sqlite.prepare("INSERT INTO automation_runs (id,trigger_kind,status,started_at,completed_at) VALUES (?,'SCHEDULED','SUCCEEDED',?,?)")
		.run(SMOKE_BATCH_ID, NOW, NOW);
	sqlite.prepare('INSERT INTO editorial_batches (id,item_count,created_at) VALUES (?,1,?)').run(SMOKE_BATCH_ID, NOW);
	intake(sqlite, SMOKE_INTAKE_ID);
	sqlite.prepare(`INSERT INTO editorial_batch_items (batch_id,source_intake_id,ordinal,category_id,workflow_state,
		selected_by_email,selected_at,created_at,updated_at) VALUES (?,?,1,'cat',?,'editor@test',?,?,?)`)
		.run(SMOKE_BATCH_ID, SMOKE_INTAKE_ID, state, NOW, NOW, NOW);
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

	it('claims only the exact one-item smoke allowlist target and never falls back', async () => {
		const sqlite = database();
		sqlite.prepare("INSERT INTO automation_runs (id,trigger_kind,status,started_at,completed_at) VALUES (?,'SCHEDULED','SUCCEEDED',?,?)")
			.run(SMOKE_BATCH_ID, NOW, NOW);
		sqlite.prepare('INSERT INTO editorial_batches (id,item_count,created_at) VALUES (?,2,?)').run(SMOKE_BATCH_ID, NOW);
		intake(sqlite, SMOKE_INTAKE_ID); intake(sqlite, 'other-intake');
		for (const [id, ordinal] of [[SMOKE_INTAKE_ID, 1], ['other-intake', 2]] as const) {
			sqlite.prepare(`INSERT INTO editorial_batch_items (batch_id,source_intake_id,ordinal,category_id,workflow_state,
				selected_by_email,selected_at,created_at,updated_at) VALUES (?,?,?,'cat','SELECTED','editor@test',?,?,?)`)
				.run(SMOKE_BATCH_ID, id, ordinal, NOW, NOW, NOW);
		}
		const repository = new D1EditorialWorkflowRepository(d1(sqlite));
		const claimed = await repository.claimProcessable({ limit: 1, owner: 'smoke', at: NOW,
			leaseExpiresAt: '2026-10-11T12:10:00.000Z', createEventId: () => 'smoke-event',
			target: { batchId: SMOKE_BATCH_ID, intakeId: SMOKE_INTAKE_ID } });
		expect(claimed.map((item) => [item.batchId, item.intakeId])).toEqual([[SMOKE_BATCH_ID, SMOKE_INTAKE_ID]]);
		expect(sqlite.prepare("SELECT workflow_state FROM editorial_batch_items WHERE source_intake_id='other-intake'").get())
			.toEqual({ workflow_state: 'SELECTED' });
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

	it('keeps a PENDING provider reservation protective after workflow lease expiry and recovery', async () => {
		const sqlite = database(); batchItem(sqlite, 'intake-1', 1);
		const workflow = new D1EditorialWorkflowRepository(d1(sqlite));
		const generation = new D1GenerationRepository(d1(sqlite));
		await workflow.claimProcessable({ limit: 1, owner: 'worker-a', at: NOW,
			leaseExpiresAt: '2026-10-11T12:10:00.000Z', createEventId: () => 'claim-a' });
		const record = { idempotencyKey: 'workflow:normalize:v2:batch:intake-1:attempt:0', operation: 'NORMALIZE' as const,
			attemptKey: 'attempt:0', sourceIntakeId: 'intake-1', normalizedEventVersionId: null, owner: 'worker-a', createdAt: NOW,
			estimatedCostMicrousd: 1,
			workflowFence: { batchId: 'batch', intakeId: 'intake-1', leaseOwner: 'worker-a' } };
		expect(await generation.admitModelBudget({ ...record, candidateId: null, budgetDay: '2026-10-11',
			limits: { enabled: true, operationMaxMicrousd: { NORMALIZE: 10, GENERATE_CANDIDATES: 10, GENERATE_ARTICLE_BODY: 10 }, itemMaxMicrousd: 10, dailyMaxMicrousd: 10 } })).toBe('ADMITTED');
		expect(await generation.claimModelRequest(record)).toBe('CLAIMED');
		expect(await generation.markModelRequestStarted(record.idempotencyKey, 'worker-a', NOW)).toBe(true);
		expect(await generation.markModelBudgetStarted(record.attemptKey, 'worker-a', NOW)).toBe(true);
		sqlite.prepare("UPDATE editorial_batch_items SET lease_expires_at='2026-10-11T11:59:00.000Z' WHERE source_intake_id='intake-1'").run();
		await workflow.claimProcessable({ limit: 1, owner: 'worker-b', at: NOW,
			leaseExpiresAt: '2026-10-11T12:10:00.000Z', createEventId: () => 'claim-b' });
		expect(await generation.claimModelRequest({ ...record, owner: 'worker-b',
			workflowFence: { ...record.workflowFence, leaseOwner: 'worker-b' } })).toBe('PENDING');
		expect(await generation.finishModelRequest({ idempotencyKey: record.idempotencyKey, owner: 'worker-b',
			status: 'SUCCEEDED', completedAt: NOW })).toBe(false);
		expect(await generation.settleModelBudget({ attemptKey: record.attemptKey, owner: 'worker-a',
			status: 'FINALIZED', resolvedAt: NOW, usageRecordedCostMicrousd: 1, resolutionReason: 'SUCCESS' })).toBe(false);
		expect(await generation.settleModelBudget({ attemptKey: record.attemptKey, owner: 'worker-a',
			status: 'AMBIGUOUS', resolvedAt: NOW, resolutionReason: 'WORKFLOW_LEASE_LOST' })).toBe(true);
		expect(await workflow.renewLease('batch', 'intake-1', 'worker-a', NOW, '2026-10-11T12:20:00.000Z')).toBe(false);
		sqlite.close();
	});

	it('atomically creates only one provider reservation under concurrent Cron processors', async () => {
		const sqlite = database(); batchItem(sqlite, 'intake-1', 1);
		const workflow = new D1EditorialWorkflowRepository(d1(sqlite));
		await workflow.claimProcessable({ limit: 1, owner: 'worker', at: NOW,
			leaseExpiresAt: '2026-10-11T12:10:00.000Z', createEventId: () => 'claim' });
		const generation = new D1GenerationRepository(d1(sqlite));
		const base = { idempotencyKey: 'request-1', operation: 'NORMALIZE' as const, attemptKey: 'attempt-1',
			sourceIntakeId: 'intake-1', normalizedEventVersionId: null, createdAt: NOW, estimatedCostMicrousd: 1,
			workflowFence: { batchId: 'batch', intakeId: 'intake-1', leaseOwner: 'worker' } };
		expect(await generation.admitModelBudget({ ...base, candidateId: null, owner: 'worker', budgetDay: '2026-10-11',
			limits: { enabled: true, operationMaxMicrousd: { NORMALIZE: 10, GENERATE_CANDIDATES: 10, GENERATE_ARTICLE_BODY: 10 }, itemMaxMicrousd: 10, dailyMaxMicrousd: 10 } })).toBe('ADMITTED');
		const results = await Promise.all([
			generation.claimModelRequest({ ...base, owner: 'worker' }),
			generation.claimModelRequest({ ...base, owner: 'worker' }),
		]);
		expect(results.sort()).toEqual(['CLAIMED', 'PENDING']);
		expect(sqlite.prepare('SELECT COUNT(*) count FROM model_request_reservations').get()).toEqual({ count: 1 });
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

	it('idempotently reconciles a READY legacy published story without changing its historical image evidence', async () => {
		const sqlite = database(); batchItem(sqlite, 'legacy-intake', 1, 'READY_FOR_REVIEW');
		sqlite.exec(`INSERT INTO satire_candidates (id,source_intake_id,proposed_headline,proposed_deck,draft_body_markdown,category_id,editorial_notes,status,created_by_email,updated_by_email,created_at,updated_at)
			VALUES ('legacy-candidate','legacy-intake','Headline','Deck','Body','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}');
			INSERT INTO stories (id,slug,headline,deck,body_markdown,edition_date,published_at,category_id,status,social_excerpt,og_image_key,tags_json,created_at,updated_at,origin_candidate_id)
			VALUES ('legacy-story','legacy-story','Headline','Deck','Body','2026-10-10','2026-10-10T18:42:46.182Z','cat','PUBLISHED','Deck',NULL,'[]','${NOW}','2026-10-10T18:42:46.182Z','legacy-candidate');
			INSERT INTO article_images (id,story_id,provider,model,prompt,prompt_version,aspect_ratio,asset_key,content_type,byte_size,status,alt_text,metadata_json,requested_by_email,requested_at,generated_at)
			VALUES ('legacy-image','legacy-story','test','test','prompt','v1','1:1','legacy-key','image/png',10,'GENERATED','Alt','{}','editor@test','${NOW}','${NOW}');
			UPDATE editorial_batch_items SET candidate_id='legacy-candidate',story_id='legacy-story' WHERE source_intake_id='legacy-intake';`);
		const before = sqlite.prepare('SELECT status,published_at,og_image_key,updated_at FROM stories WHERE id=?').get('legacy-story');
		const repository = new D1EditorialWorkflowRepository(d1(sqlite)); let id = 0;
		expect(await repository.reconcilePublished({ limit: 50, actorEmail: 'automation@test', at: NOW,
			createEventId: () => `legacy-event-${++id}`, createAuditId: () => `legacy-audit-${++id}` })).toBe(1);
		expect(await repository.findItem('batch', 'legacy-intake')).toMatchObject({ state: 'PUBLISHED', storyId: 'legacy-story' });
		expect(sqlite.prepare('SELECT status,published_at,og_image_key,updated_at FROM stories WHERE id=?').get('legacy-story')).toEqual(before);
		expect(sqlite.prepare('SELECT status,reviewed_at,reviewed_by_email FROM article_images WHERE id=?').get('legacy-image'))
			.toEqual({ status: 'GENERATED', reviewed_at: null, reviewed_by_email: null });
		expect(sqlite.prepare("SELECT from_status,to_status,reason FROM editorial_audit_log WHERE action='WORKFLOW_RECONCILED'").get())
			.toEqual({ from_status: 'READY_FOR_REVIEW', to_status: 'PUBLISHED', reason: 'STATE_ONLY;prior=READY_FOR_REVIEW;image_evidence=LEGACY_MISSING_APPROVED_IMAGE' });
		expect(sqlite.prepare("SELECT detail FROM editorial_workflow_events WHERE event_kind='WORKFLOW_PUBLISHED_RECONCILED'").get())
			.toEqual({ detail: 'STATE_ONLY;prior=READY_FOR_REVIEW;image_evidence=LEGACY_MISSING_APPROVED_IMAGE' });
		expect(await repository.reconcilePublished({ limit: 50, actorEmail: 'automation@test', at: NOW,
			createEventId: () => `legacy-event-${++id}`, createAuditId: () => `legacy-audit-${++id}` })).toBe(0);
		expect(sqlite.prepare("SELECT COUNT(*) count FROM editorial_audit_log WHERE action='WORKFLOW_RECONCILED'").get()).toEqual({ count: 1 });
		expect(sqlite.prepare("SELECT COUNT(*) count FROM editorial_workflow_events WHERE event_kind='WORKFLOW_PUBLISHED_RECONCILED'").get()).toEqual({ count: 1 });
		sqlite.close();
	});

	it('atomically publishes APPROVED to PUBLISHED only with a matching explicitly approved image', async () => {
		const sqlite = database(); batchItem(sqlite, 'publish-intake', 1, 'READY_FOR_REVIEW');
		sqlite.exec(`INSERT INTO satire_candidates (id,source_intake_id,proposed_headline,proposed_deck,draft_body_markdown,category_id,editorial_notes,status,created_by_email,updated_by_email,created_at,updated_at)
			VALUES ('publish-candidate','publish-intake','Headline','Deck','Body','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}');
			INSERT INTO stories (id,slug,headline,deck,body_markdown,edition_date,category_id,status,social_excerpt,og_image_key,tags_json,created_at,updated_at,origin_candidate_id)
			VALUES ('publish-story','publish-story','Headline','Deck','Body','2026-10-11','cat','APPROVED','Deck','approved-key','[]','${NOW}','${NOW}','publish-candidate');
			INSERT INTO article_images (id,story_id,provider,model,prompt,prompt_version,aspect_ratio,asset_key,content_type,byte_size,status,alt_text,metadata_json,requested_by_email,requested_at,generated_at,reviewed_by_email,reviewed_at)
			VALUES ('publish-image','publish-story','test','test','prompt','v1','1:1','approved-key','image/png',10,'APPROVED','Alt','{}','editor@test','${NOW}','${NOW}','editor@test','${NOW}');
			UPDATE editorial_batch_items SET candidate_id='publish-candidate',story_id='publish-story' WHERE source_intake_id='publish-intake';`);
		const repository = new D1EditorialWorkflowRepository(d1(sqlite));
		expect(await repository.findPublicationReadiness('publish-story')).toBe('READY');
		expect(await repository.publishFinal({ batchId: 'batch', intakeId: 'publish-intake', storyId: 'publish-story',
			actorEmail: 'editor@test', at: NOW, eventId: 'publish-event', auditId: 'publish-audit' })).toBe(true);
		expect(sqlite.prepare('SELECT status,published_at FROM stories WHERE id=?').get('publish-story'))
			.toEqual({ status: 'PUBLISHED', published_at: NOW });
		expect(sqlite.prepare('SELECT workflow_state FROM editorial_batch_items WHERE source_intake_id=?').get('publish-intake'))
			.toEqual({ workflow_state: 'PUBLISHED' });
		expect(sqlite.prepare("SELECT from_status,to_status FROM editorial_audit_log WHERE id='publish-audit'").get())
			.toEqual({ from_status: 'APPROVED', to_status: 'PUBLISHED' });
		expect(await repository.publishFinal({ batchId: 'batch', intakeId: 'publish-intake', storyId: 'publish-story',
			actorEmail: 'editor@test', at: NOW, eventId: 'duplicate-event', auditId: 'duplicate-audit' })).toBe(false);
		expect(sqlite.prepare("SELECT COUNT(*) count FROM editorial_audit_log WHERE action='PUBLISHED'").get()).toEqual({ count: 1 });
		expect(sqlite.prepare("SELECT COUNT(*) count FROM editorial_workflow_events WHERE event_kind='ARTICLE_PUBLISHED'").get()).toEqual({ count: 1 });
		sqlite.close();
	});

	it('applies the same atomic image and approval predicate to standalone publication', async () => {
		const sqlite = database();
		sqlite.exec(`INSERT INTO stories (id,slug,headline,deck,body_markdown,edition_date,category_id,status,social_excerpt,og_image_key,tags_json,created_at,updated_at)
			VALUES ('standalone-story','standalone-story','Headline','Deck','Body','2026-10-11','cat','APPROVED','Deck','standalone-key','[]','${NOW}','${NOW}');
			INSERT INTO article_images (id,story_id,provider,model,prompt,prompt_version,aspect_ratio,asset_key,content_type,byte_size,status,alt_text,metadata_json,requested_by_email,requested_at,generated_at,reviewed_by_email,reviewed_at)
			VALUES ('standalone-image','standalone-story','test','test','prompt','v1','1:1','standalone-key','image/png',10,'APPROVED','Alt','{}','editor@test','${NOW}','${NOW}','editor@test','${NOW}');`);
		const repository = new D1EditorialRepository(d1(sqlite));
		expect(await repository.findPublicationReadiness('standalone-story')).toBe('READY');
		expect(await repository.publishApprovedStory({ id: 'standalone-story', actorEmail: 'editor@test',
			publishedAt: NOW, auditId: 'standalone-audit' })).toBe(true);
		expect(sqlite.prepare('SELECT status,published_at FROM stories WHERE id=?').get('standalone-story'))
			.toEqual({ status: 'PUBLISHED', published_at: NOW });
		expect(sqlite.prepare("SELECT from_status,to_status FROM editorial_audit_log WHERE id='standalone-audit'").get())
			.toEqual({ from_status: 'APPROVED', to_status: 'PUBLISHED' });
		expect(await repository.publishApprovedStory({ id: 'standalone-story', actorEmail: 'editor@test',
			publishedAt: NOW, auditId: 'standalone-duplicate' })).toBe(false);
		expect(sqlite.prepare("SELECT COUNT(*) count FROM editorial_audit_log WHERE action='PUBLISHED'").get()).toEqual({ count: 1 });
		sqlite.close();
	});

	it.each([
		['missing', 'IMAGE_REQUIRED', null, null],
		['generated', 'IMAGE_NOT_APPROVED', 'GENERATED', 'image-key'],
		['mismatched', 'IMAGE_NOT_APPROVED', 'APPROVED', 'different-key'],
	] as const)('fails closed for %s image evidence', async (_label, expected, imageStatus, imageKey) => {
		const sqlite = database(); batchItem(sqlite, 'blocked-intake', 1, 'READY_FOR_REVIEW');
		sqlite.exec(`INSERT INTO stories (id,slug,headline,deck,body_markdown,edition_date,category_id,status,social_excerpt,og_image_key,tags_json,created_at,updated_at)
			VALUES ('blocked-story','blocked-story','Headline','Deck','Body','2026-10-11','cat','APPROVED','Deck',${imageKey ? "'image-key'" : 'NULL'},'[]','${NOW}','${NOW}');
			UPDATE editorial_batch_items SET story_id='blocked-story' WHERE source_intake_id='blocked-intake';`);
		if (imageStatus) sqlite.prepare(`INSERT INTO article_images (id,story_id,provider,model,prompt,prompt_version,aspect_ratio,asset_key,content_type,byte_size,status,alt_text,metadata_json,requested_by_email,requested_at,generated_at,reviewed_by_email,reviewed_at)
			VALUES ('blocked-image','blocked-story','test','test','prompt','v1','1:1',?,'image/png',10,?,'Alt','{}','editor@test',?,?,?,?)`)
			.run(imageKey, imageStatus, NOW, NOW, imageStatus === 'APPROVED' ? 'editor@test' : null, imageStatus === 'APPROVED' ? NOW : null);
		const repository = new D1EditorialWorkflowRepository(d1(sqlite));
		expect(await repository.findPublicationReadiness('blocked-story')).toBe(expected);
		expect(await repository.publishFinal({ batchId: 'batch', intakeId: 'blocked-intake', storyId: 'blocked-story',
			actorEmail: 'editor@test', at: NOW, eventId: 'blocked-event', auditId: 'blocked-audit' })).toBe(false);
		expect(sqlite.prepare('SELECT status,published_at FROM stories WHERE id=?').get('blocked-story'))
			.toEqual({ status: 'APPROVED', published_at: null });
		expect(sqlite.prepare("SELECT COUNT(*) count FROM editorial_audit_log WHERE action='PUBLISHED'").get()).toEqual({ count: 0 });
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

	it('allows only an explicitly image-disabled smoke path to become review-ready without an image', async () => {
		const sqlite = database(); smokeBatchItem(sqlite);
		sqlite.exec(`INSERT INTO satire_candidates (id,source_intake_id,proposed_headline,proposed_deck,draft_body_markdown,category_id,editorial_notes,status,created_by_email,updated_by_email,created_at,updated_at,body_generation_state)
			VALUES ('candidate','${SMOKE_INTAKE_ID}','Headline','Deck','Body','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}','SUCCEEDED');
			INSERT INTO stories (id,slug,headline,deck,body_markdown,edition_date,category_id,status,social_excerpt,tags_json,created_at,updated_at,origin_candidate_id)
			VALUES ('story','review-story','Headline','Deck','Body','2026-10-11','cat','REVIEW','Deck','[]','${NOW}','${NOW}','candidate');
			UPDATE editorial_batch_items SET candidate_id='candidate',story_id='story',lease_owner='worker',lease_acquired_at='${NOW}',lease_expires_at='2026-10-11T12:10:00.000Z' WHERE source_intake_id='${SMOKE_INTAKE_ID}';`);
		const repository = new D1EditorialWorkflowRepository(d1(sqlite));
		expect(await repository.markReady(SMOKE_BATCH_ID, SMOKE_INTAKE_ID, 'story', 'worker', NOW, 'normal-ready')).toBe(false);
		expect(await repository.markReady(SMOKE_BATCH_ID, SMOKE_INTAKE_ID, 'story', 'worker', NOW, 'smoke-ready', true)).toBe(true);
		expect(await repository.findItem(SMOKE_BATCH_ID, SMOKE_INTAKE_ID)).toMatchObject({ state: 'READY_FOR_REVIEW' });
		expect(sqlite.prepare('SELECT og_image_key,status,published_at FROM stories WHERE id=?').get('story'))
			.toEqual({ og_image_key: null, status: 'REVIEW', published_at: null });
		expect(await repository.publishFinal({ batchId: SMOKE_BATCH_ID, intakeId: SMOKE_INTAKE_ID, storyId: 'story',
			actorEmail: 'editor@test', at: NOW, eventId: 'publish-event', auditId: 'publish-audit' })).toBe(false);
		expect(sqlite.prepare('SELECT status,published_at,og_image_key FROM stories WHERE id=?').get('story'))
			.toEqual({ status: 'REVIEW', published_at: null, og_image_key: null });
		sqlite.close();
	});

	it('replays a completed body and existing REVIEW story without creating duplicates', async () => {
		const sqlite = database(); smokeBatchItem(sqlite);
		sqlite.exec(`INSERT INTO normalized_event_versions (id,source_intake_id,version_number,review_state,origin,event_statement,proposed_significance_score,proposed_satire_potential_score,proposed_suitability,suitability_reason,created_by_email,reviewed_by_email,created_at,reviewed_at)
			VALUES ('version','${SMOKE_INTAKE_ID}',1,'ACCEPTED','EDITOR','Event',2,3,'SUITABLE','Reviewed','editor@test','editor@test','${NOW}','${NOW}');
			INSERT INTO satire_candidates (id,source_intake_id,proposed_headline,proposed_deck,draft_body_markdown,category_id,editorial_notes,status,created_by_email,updated_by_email,created_at,updated_at,normalized_event_version_id,body_generation_state,body_generation_run_id)
			VALUES ('candidate','${SMOKE_INTAKE_ID}','Headline','Deck','Body','cat','','DRAFT','editor@test','editor@test','${NOW}','${NOW}','version','SUCCEEDED','body-run');
			INSERT INTO candidate_body_generation_runs (id,status,candidate_id,source_intake_id,normalized_event_version_id,provider,model,prompt_version,input_hash,output_hash,input_tokens,output_tokens,input_characters,output_characters,latency_ms,retry_count,estimated_cost_microusd,idempotency_key,requested_by_email,source_was_sensitive,created_at,completed_at)
			VALUES ('body-run','SUCCEEDED','candidate','${SMOKE_INTAKE_ID}','version','test','test','article-body-v2','input','output',1,1,10,10,1,0,1,'body-key','editor@test',0,'${NOW}','${NOW}');
			INSERT INTO stories (id,slug,headline,deck,body_markdown,edition_date,category_id,status,social_excerpt,tags_json,created_at,updated_at,origin_candidate_id)
			VALUES ('story','review-story','Headline','Deck','Body','2026-10-11','cat','REVIEW','Deck','[]','${NOW}','${NOW}','candidate');
			UPDATE editorial_batch_items SET candidate_id='candidate',lease_owner='worker',lease_acquired_at='${NOW}',lease_expires_at='2026-10-11T12:10:00.000Z' WHERE source_intake_id='${SMOKE_INTAKE_ID}';`);
		const repository = new D1EditorialWorkflowRepository(d1(sqlite));
		expect(await repository.attachExistingStory({ batchId: SMOKE_BATCH_ID, intakeId: SMOKE_INTAKE_ID, candidateId: 'candidate',
			storyId: 'story', owner: 'worker', at: NOW, eventId: 'attach-existing' })).toBe(true);
		expect(await repository.markReady(SMOKE_BATCH_ID, SMOKE_INTAKE_ID, 'story', 'worker', NOW, 'ready-existing', true)).toBe(true);
		expect(sqlite.prepare('SELECT COUNT(*) count FROM candidate_body_generation_runs').get()).toEqual({ count: 1 });
		expect(sqlite.prepare('SELECT COUNT(*) count FROM stories').get()).toEqual({ count: 1 });
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
