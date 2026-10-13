import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { D1GovernedPublicationRepository } from '../src/data/d1-governed-publication-repository';
import { D1EditorialWorkflowRepository } from '../src/data/d1-editorial-workflow-repository';
import type { GovernedPublicationRepository } from '../src/data/governed-publication-repository';
import { GovernedAutomatedPublicationService, automatedPublicationEnabled } from '../src/services/governed-automated-publication-service';

const NOW = '2026-10-13T12:00:00.000Z';
const execute = Symbol('execute');

function d1Database(sqlite: DatabaseSync): D1Database {
	return { prepare(query: string) { let bindings: unknown[] = []; const statement = {
		bind(...values: unknown[]) { bindings = values; return statement; },
		async first<T>() { return (sqlite.prepare(query).get(...bindings as never[]) as T | undefined) ?? null; },
		async all<T>() { return { success: true, results: sqlite.prepare(query).all(...bindings as never[]) as T[] } as D1Result<T>; },
		async run<T>() { return statement[execute]() as D1Result<T>; },
		[execute]() { const result = sqlite.prepare(query).run(...bindings as never[]); return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result; },
	}; return statement as unknown as D1PreparedStatement; },
	async batch<T>(statements: D1PreparedStatement[]) {
		sqlite.exec('BEGIN IMMEDIATE');
		try {
			const results = statements.map((statement) => (statement as D1PreparedStatement & { [execute]: () => D1Result })[execute]());
			sqlite.exec('COMMIT'); return results as D1Result<T>[];
		} catch (error) { sqlite.exec('ROLLBACK'); throw error; }
	} } as unknown as D1Database;
}

function database(options: { image?: boolean; routine?: boolean; storyStatus?: 'APPROVED' | 'REJECTED'; activeLease?: boolean; readyNotice?: boolean } = {}): DatabaseSync {
	const { image = true, routine = true, storyStatus = 'APPROVED', activeLease = false, readyNotice = true } = options;
	const sqlite = new DatabaseSync(':memory:');
	for (const filename of readdirSync(join(process.cwd(), 'migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
		sqlite.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
	}
	sqlite.exec(`
		INSERT INTO categories (id,slug,name,created_at) VALUES ('cat-1','civic-life','Civic Life','${NOW}');
		INSERT INTO source_intakes (id,title,neutral_brief,significance_score,satire_potential_score,satire_suitability,editorial_notes,created_by_email,updated_by_email,created_at,updated_at)
		VALUES ('intake-1','Title','Brief',3,3,'SUITABLE','','automation@tomorrow-ish.news','automation@tomorrow-ish.news','${NOW}','${NOW}');
		INSERT INTO normalized_event_versions (id,source_intake_id,version_number,review_state,origin,event_statement,proposed_significance_score,proposed_satire_potential_score,proposed_suitability,suitability_reason,created_by_email,reviewed_by_email,review_reason,created_at,reviewed_at)
		VALUES ('version-1','intake-1',1,'ACCEPTED','MODEL','Event',3,3,'SUITABLE','Safe','automation@tomorrow-ish.news','automation@tomorrow-ish.news','routine','${NOW}','${NOW}');
		INSERT INTO satire_candidates (id,source_intake_id,proposed_headline,proposed_deck,draft_body_markdown,category_id,status,created_by_email,updated_by_email,created_at,updated_at,normalized_event_version_id,origin_kind)
		VALUES ('candidate-1','intake-1','Headline','Deck','Body','cat-1','DRAFT','automation@tomorrow-ish.news','automation@tomorrow-ish.news','${NOW}','${NOW}','version-1','MODEL');
		INSERT INTO stories (id,slug,headline,deck,body_markdown,edition_date,category_id,status,social_excerpt,og_image_key,created_at,updated_at,origin_candidate_id)
		VALUES ('story-1','story-one','Headline','Deck','Body','2026-10-13','cat-1','${storyStatus}','Excerpt',${image ? "'images/story-1.webp'" : 'NULL'},'${NOW}','${NOW}','candidate-1');
		INSERT INTO automation_runs (id,trigger_kind,status,started_at,completed_at) VALUES ('batch-1','SCHEDULED','SUCCEEDED','${NOW}','${NOW}');
		INSERT INTO editorial_batches (id,item_count,created_at) VALUES ('batch-1',3,'${NOW}');
		INSERT INTO editorial_stage_reminders (batch_id,stage,created_at,initial_sent_at)
		VALUES ('batch-1','FINAL_REVIEW','${NOW}',${readyNotice ? `'${NOW}'` : 'NULL'});
		INSERT INTO editorial_batch_items (batch_id,source_intake_id,ordinal,category_id,workflow_state,selected_by_email,selected_at,candidate_id,story_id,created_at,updated_at,lease_owner,lease_acquired_at,lease_expires_at)
		VALUES ('batch-1','intake-1',1,'cat-1','READY_FOR_REVIEW','automation@tomorrow-ish.news','${NOW}','candidate-1','story-1','${NOW}','${NOW}',${activeLease ? "'other-owner'" : 'NULL'},${activeLease ? `'${NOW}'` : 'NULL'},${activeLease ? "'2026-10-13T13:00:00.000Z'" : 'NULL'});
		INSERT INTO editorial_candidate_selections (batch_id,source_intake_id,normalized_event_version_id,candidate_id,selected_by_email,selected_at,revision)
		VALUES ('batch-1','intake-1','version-1','candidate-1','automation@tomorrow-ish.news','${NOW}',1);
		INSERT INTO editorial_workflow_events (id,batch_id,source_intake_id,event_kind,detail,created_at)
		VALUES ('selected-event','batch-1','intake-1','INTAKE_SELECTED','${routine ? 'routine-generation:v1' : 'manual'}','${NOW}');
	`);
	if (image) sqlite.exec(`INSERT INTO article_images (id,story_id,provider,model,prompt,prompt_version,aspect_ratio,provider_request_id,asset_key,content_type,byte_size,status,alt_text,requested_by_email,requested_at,generated_at,reviewed_by_email,reviewed_at)
		VALUES ('image-1','story-1','provider','model','prompt','v1','3:2','request-1','images/story-1.webp','image/webp',100,'APPROVED','Alt text','editor@example.com','${NOW}','${NOW}','editor@example.com','${NOW}');`);
	return sqlite;
}

function service(repository: GovernedPublicationRepository, enabled = true) {
	let id = 0;
	return new GovernedAutomatedPublicationService(repository, enabled, 'automation@tomorrow-ish.news',
		() => new Date(NOW), () => `id-${++id}`);
}

describe('governed automated publication', () => {
	it('is disabled by default and rejects malformed configuration', async () => {
		expect(automatedPublicationEnabled(undefined)).toBe(false);
		expect(automatedPublicationEnabled('false')).toBe(false);
		expect(() => automatedPublicationEnabled('yes')).toThrow(/true or false/);
		const repository: GovernedPublicationRepository = { claimNext: vi.fn(), publish: vi.fn() };
		expect(await service(repository, false).process()).toEqual({ disabled: true, claimed: 0, published: 0, failed: 0 });
		expect(repository.claimNext).not.toHaveBeenCalled();
	});

	it('atomically publishes an eligible routine story and its workflow exactly once', async () => {
		const sqlite = database(); const repository = new D1GovernedPublicationRepository(d1Database(sqlite));
		expect(await service(repository).process()).toEqual({ disabled: false, claimed: 1, published: 1, failed: 0 });
		expect(await service(repository).process()).toEqual({ disabled: false, claimed: 0, published: 0, failed: 0 });
		expect(sqlite.prepare('SELECT status, published_at FROM stories WHERE id = ?').get('story-1'))
			.toEqual({ status: 'PUBLISHED', published_at: NOW });
		expect(sqlite.prepare('SELECT workflow_state FROM editorial_batch_items WHERE story_id = ?').get('story-1'))
			.toEqual({ workflow_state: 'PUBLISHED' });
		expect(sqlite.prepare("SELECT COUNT(*) AS count FROM editorial_audit_log WHERE entity_id = 'story-1' AND action = 'PUBLISHED'").get()).toEqual({ count: 1 });
		expect(sqlite.prepare("SELECT COUNT(*) AS count FROM editorial_workflow_events WHERE story_id = 'story-1' AND event_kind = 'ARTICLE_PUBLISHED'").get()).toEqual({ count: 1 });
		expect(sqlite.prepare('SELECT status, attempt_count FROM editorial_publication_attempts').get())
			.toEqual({ status: 'PUBLISHED', attempt_count: 1 });
		sqlite.close();
	});

	it.each([
		['missing approved image', { image: false }],
		['rejected article', { storyStatus: 'REJECTED' as const }],
		['historical or manual record', { routine: false }],
		['active foreign workflow lease', { activeLease: true }],
		['batch without an exactly-three readiness notification', { readyNotice: false }],
	])('fails closed for %s', async (_label, options) => {
		const sqlite = database(options); const repository = new D1GovernedPublicationRepository(d1Database(sqlite));
		expect(await service(repository).process()).toEqual({ disabled: false, claimed: 0, published: 0, failed: 0 });
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM editorial_publication_attempts').get()).toEqual({ count: 0 });
		expect(sqlite.prepare('SELECT published_at FROM stories WHERE id = ?').get('story-1')).toEqual({ published_at: null });
		sqlite.close();
	});

	it('admits one owner under concurrent processors and prevents duplicate publication', async () => {
		const sqlite = database(); const db = d1Database(sqlite);
		const first = new D1GovernedPublicationRepository(db); const second = new D1GovernedPublicationRepository(db);
		let id = 0; const createId = () => `claim-${++id}`;
		const claims = await Promise.all([
			first.claimNext({ owner: 'owner-1', actorEmail: 'automation@tomorrow-ish.news', at: NOW, leaseExpiresAt: '2026-10-13T12:05:00.000Z', createId }),
			second.claimNext({ owner: 'owner-2', actorEmail: 'automation@tomorrow-ish.news', at: NOW, leaseExpiresAt: '2026-10-13T12:05:00.000Z', createId }),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		const claim = claims.find(Boolean)!;
		expect(await Promise.all([first.publish(claim, NOW), second.publish({ ...claim, owner: 'stale-owner' }, NOW)]))
			.toEqual([true, false]);
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM editorial_publication_attempts').get()).toEqual({ count: 1 });
		sqlite.close();
	});

	it('allows a stale publication lease to be recovered without weakening publication predicates', async () => {
		const sqlite = database(); const repository = new D1GovernedPublicationRepository(d1Database(sqlite));
		let id = 0; const createId = () => `recover-${++id}`;
		const first = await repository.claimNext({ owner: 'crashed-owner', actorEmail: 'automation@tomorrow-ish.news',
			at: NOW, leaseExpiresAt: '2026-10-13T12:05:00.000Z', createId });
		expect(first).not.toBeNull();
		const recovered = await repository.claimNext({ owner: 'recovered-owner', actorEmail: 'automation@tomorrow-ish.news',
			at: '2026-10-13T12:06:00.000Z', leaseExpiresAt: '2026-10-13T12:11:00.000Z', createId });
		expect(recovered).toMatchObject({ storyId: 'story-1', owner: 'recovered-owner' });
		expect(await repository.publish(first!, '2026-10-13T12:06:00.000Z')).toBe(false);
		expect(await repository.publish(recovered!, '2026-10-13T12:06:00.000Z')).toBe(true);
		expect(sqlite.prepare('SELECT status, attempt_count FROM editorial_publication_attempts').get())
			.toEqual({ status: 'PUBLISHED', attempt_count: 2 });
		sqlite.close();
	});

	it('prevents the manual route from racing an active scheduled publication claim', async () => {
		const sqlite = database(); const db = d1Database(sqlite);
		const automated = new D1GovernedPublicationRepository(db); let id = 0;
		const claim = await automated.claimNext({ owner: 'scheduled-owner', actorEmail: 'automation@tomorrow-ish.news',
			at: NOW, leaseExpiresAt: '2026-10-13T12:05:00.000Z', createId: () => `race-${++id}` });
		expect(claim).not.toBeNull();
		const manual = new D1EditorialWorkflowRepository(db);
		expect(await manual.publishFinal({ batchId: 'batch-1', intakeId: 'intake-1', storyId: 'story-1',
			actorEmail: 'editor@example.com', at: NOW, eventId: 'manual-event', auditId: 'manual-audit' })).toBe(false);
		expect(sqlite.prepare('SELECT status, published_at FROM stories WHERE id = ?').get('story-1'))
			.toEqual({ status: 'APPROVED', published_at: null });
		expect(await automated.publish(claim!, NOW)).toBe(true);
		sqlite.close();
	});
});
