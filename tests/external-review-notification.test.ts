import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { D1ExternalReviewNotificationRepository } from '../src/data/external-review-notification-repository';
import type { ExternalReviewNotificationRepository } from '../src/data/external-review-notification-repository';
import { DurableExternalReviewNotifier } from '../src/notifications/durable-external-review-notifier';
import { ReviewNotificationError, WebhookReviewNotifier, type ReviewNotification } from '../src/notifications/review-notifier';

const NOW = '2026-10-13T12:00:00.000Z';
const execute = Symbol('execute');
const notification: ReviewNotification = {
	batchId: 'batch-1', stage: 'TRIAGE', kind: 'INITIAL',
	message: 'Three intakes are ready.', reviewUrl: 'https://tomorrow-ish.news/editorial/batches/batch-1/triage',
	idempotencyKey: 'editorial-review:batch-1:TRIAGE:INITIAL',
};

function d1Database(sqlite: DatabaseSync): D1Database {
	return { prepare(query: string) { let bindings: unknown[] = []; const statement = {
		bind(...values: unknown[]) { bindings = values; return statement; },
		async first<T>() { return (sqlite.prepare(query).get(...bindings as never[]) as T | undefined) ?? null; },
		async all<T>() { return { success: true, results: sqlite.prepare(query).all(...bindings as never[]) as T[] } as D1Result<T>; },
		async run<T>() { return statement[execute]() as D1Result<T>; },
		[execute]() { const result = sqlite.prepare(query).run(...bindings as never[]); return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result; },
	}; return statement as unknown as D1PreparedStatement; } } as unknown as D1Database;
}

function database(): DatabaseSync {
	const sqlite = new DatabaseSync(':memory:');
	for (const filename of readdirSync(join(process.cwd(), 'migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
		sqlite.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
	}
	sqlite.exec(`INSERT INTO automation_runs (id, trigger_kind, status, started_at, completed_at)
		VALUES ('batch-1','SCHEDULED','SUCCEEDED','${NOW}','${NOW}');
		INSERT INTO editorial_batches (id,item_count,created_at) VALUES ('batch-1',3,'${NOW}');
		INSERT INTO editorial_stage_reminders (batch_id,stage,created_at,claim_kind,claim_token,claimed_at)
		VALUES ('batch-1','TRIAGE','${NOW}','INITIAL','claim-1','${NOW}');`);
	return sqlite;
}

describe('durable external review notification delivery', () => {
	it('admits one concurrent send and records delivery only after a successful response', async () => {
		const sqlite = database();
		const repository = new D1ExternalReviewNotificationRepository(d1Database(sqlite));
		const fetcher = vi.fn(async () => new Response(null, { status: 200, headers: { 'x-request-id': 'request-1' } }));
		let sequence = 0;
		const notifier = new DurableExternalReviewNotifier(repository,
			new WebhookReviewNotifier('https://notify.example/hooks/editorial', fetcher),
			() => NOW, () => `owner-${++sequence}`);

		const results = await Promise.allSettled([notifier.send(notification), notifier.send(notification)]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		expect(sqlite.prepare(`SELECT status, attempt_count, response_status, provider_request_id
			FROM external_review_notification_deliveries`).get()).toEqual({
			status: 'DELIVERED', attempt_count: 1, response_status: 200, provider_request_id: 'request-1',
		});
		sqlite.close();
	});

	it('does not mark a merely queued HTTP 202 response as delivered', async () => {
		const sqlite = database();
		const repository = new D1ExternalReviewNotificationRepository(d1Database(sqlite));
		const fetcher = vi.fn(async () => new Response(null, { status: 202, headers: { 'x-request-id': 'queued-1' } }));
		const notifier = new DurableExternalReviewNotifier(repository,
			new WebhookReviewNotifier('https://notify.example/hooks/editorial', fetcher), () => NOW, () => 'owner-1');
		await expect(notifier.send(notification)).rejects.toMatchObject({ classification: 'AMBIGUOUS' });
		expect(sqlite.prepare(`SELECT status, delivered_at, response_status, failure_classification
			FROM external_review_notification_deliveries`).get()).toEqual({
			status: 'AMBIGUOUS', delivered_at: null, response_status: 202,
			failure_classification: 'QUEUED_WITHOUT_DELIVERY_CONFIRMATION',
		});
		sqlite.close();
	});

	it('keeps network loss and uncertain HTTP responses ambiguous and never resubmits', async () => {
		for (const fetcher of [
			vi.fn(async () => { throw new Error('connection lost'); }),
			vi.fn(async () => new Response(null, { status: 503, headers: { 'x-request-id': 'request-uncertain' } })),
		]) {
			const sqlite = database();
			const repository = new D1ExternalReviewNotificationRepository(d1Database(sqlite));
			const notifier = new DurableExternalReviewNotifier(repository,
				new WebhookReviewNotifier('https://notify.example/hooks/editorial', fetcher), () => NOW, () => 'owner-1');
			await expect(notifier.send(notification)).rejects.toMatchObject({ classification: 'AMBIGUOUS' });
			await expect(notifier.send(notification)).rejects.toMatchObject({ classification: 'AMBIGUOUS' });
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(sqlite.prepare('SELECT status, attempt_count FROM external_review_notification_deliveries').get())
				.toEqual({ status: 'AMBIGUOUS', attempt_count: 1 });
			sqlite.close();
		}
	});

	it('records definitive webhook rejection as failed and does not retry it automatically', async () => {
		const sqlite = database();
		const repository = new D1ExternalReviewNotificationRepository(d1Database(sqlite));
		const fetcher = vi.fn(async () => new Response(null, { status: 400, headers: { 'x-request-id': 'bad-1' } }));
		const notifier = new DurableExternalReviewNotifier(repository,
			new WebhookReviewNotifier('https://notify.example/hooks/editorial', fetcher), () => NOW, () => 'owner-1');
		await expect(notifier.send(notification)).rejects.toBeInstanceOf(ReviewNotificationError);
		await expect(notifier.send(notification)).rejects.toMatchObject({ classification: 'AMBIGUOUS' });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(sqlite.prepare(`SELECT status, failure_classification, response_status
			FROM external_review_notification_deliveries`).get()).toEqual({
			status: 'FAILED', failure_classification: 'REJECTED', response_status: 400,
		});
		sqlite.close();
	});

	it('keeps a possibly accepted request protected when completion persistence fails', async () => {
		let state: 'empty' | 'pending' = 'empty';
		const repository: ExternalReviewNotificationRepository = {
			reserve: vi.fn(async () => { if (state === 'pending') return 'BLOCKED'; state = 'pending'; return 'ACQUIRED'; }),
			markDelivered: vi.fn(async () => false),
			markFailed: vi.fn(async () => false),
			markAmbiguous: vi.fn(async () => true),
		};
		const transport = { send: vi.fn(async () => ({ status: 200, requestId: 'accepted-1' })) };
		const notifier = new DurableExternalReviewNotifier(repository, transport, () => NOW, () => 'owner-1');
		await expect(notifier.send(notification)).rejects.toMatchObject({ classification: 'AMBIGUOUS' });
		await expect(notifier.send(notification)).rejects.toMatchObject({ classification: 'AMBIGUOUS' });
		expect(transport.send).toHaveBeenCalledTimes(1);
		expect(repository.markAmbiguous).toHaveBeenCalled();
	});
});
