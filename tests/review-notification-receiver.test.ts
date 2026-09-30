import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
	D1EditorialNotificationDelivery,
	D1ReviewNotificationRepository,
} from '../src/data/d1-review-notification-repository';
import type { EditorialNotificationDeliveryPort } from '../src/data/review-notification-repository';
import { handleReviewNotificationRequest } from '../src/notifications/review-notification-endpoint';
import { InternalReviewNotifier, ReviewNotificationError } from '../src/notifications/review-notifier';
import { ReviewNotificationReceiverService } from '../src/services/review-notification-receiver-service';

const NOW = '2026-09-30T12:00:00.000Z';
const execute = Symbol('execute');

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
	sqlite.exec(`
		INSERT INTO categories (id, slug, name, created_at) VALUES ('cat-1', 'civic-life', 'Civic Life', '${NOW}');
		INSERT INTO stories (id, slug, headline, deck, body_markdown, edition_date, category_id, status, social_excerpt, created_at, updated_at)
		VALUES ('story-1', 'unchanged', 'Unchanged', 'Deck', 'Body', '2026-09-30', 'cat-1', 'REVIEW', 'Excerpt', '${NOW}', '${NOW}');
		INSERT INTO automation_runs (id, trigger_kind, status, started_at, completed_at)
		VALUES ('batch-1', 'SCHEDULED', 'SUCCEEDED', '${NOW}', '${NOW}');
		INSERT INTO editorial_batches (id, item_count, created_at) VALUES ('batch-1', 1, '${NOW}');
		INSERT INTO editorial_stage_reminders (batch_id, stage, created_at, claim_kind, claim_token, claimed_at)
		VALUES ('batch-1', 'TRIAGE', '${NOW}', 'INITIAL', 'claim-1', '${NOW}');
	`);
	return sqlite;
}

function request(overrides: Record<string, unknown> = {}, idempotencyKey = 'editorial-review:batch-1:TRIAGE:INITIAL'): Request {
	return new Request('https://example.test/api/internal/review-notifications', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
		body: JSON.stringify({
			text: 'Tomorrow-ish has 1 new intake ready for editorial triage.',
			reviewUrl: 'https://example.test/editorial/batches/batch-1/triage',
			batchId: 'batch-1', reminderStage: 'TRIAGE', reminderKind: 'INITIAL',
			...overrides,
		}),
	});
}

function receiver(db: D1Database, delivery: EditorialNotificationDeliveryPort = new D1EditorialNotificationDelivery(db)) {
	const receipts = new D1ReviewNotificationRepository(db);
	return { receipts, service: new ReviewNotificationReceiverService(receipts, delivery, () => NOW) };
}

describe('internal review notification receiver', () => {
	it('accepts the exact sender contract and records one human-visible notification', async () => {
		const sqlite = database(); const db = d1Database(sqlite); const test = receiver(db);
		const response = await handleReviewNotificationRequest(request(), test.service);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ state: 'accepted' });
		expect(await test.receipts.listDelivered()).toEqual([expect.objectContaining({
			idempotencyKey: 'editorial-review:batch-1:TRIAGE:INITIAL', batchId: 'batch-1', stage: 'TRIAGE', kind: 'INITIAL',
		})]);
		sqlite.close();
	});

	it.each([
		['missing field', { reviewUrl: undefined }, 'editorial-review:batch-1:TRIAGE:INITIAL'],
		['unknown stage', { reminderStage: 'DRAFT' }, 'editorial-review:batch-1:DRAFT:INITIAL'],
		['mismatched key', {}, 'editorial-review:batch-1:TRIAGE'],
		['foreign review URL', { reviewUrl: 'https://attacker.example/editorial/batches/batch-1/triage' }, 'editorial-review:batch-1:TRIAGE:INITIAL'],
	])('rejects malformed payload: %s', async (_label, overrides, key) => {
		const sqlite = database(); const db = d1Database(sqlite); const test = receiver(db);
		const response = await handleReviewNotificationRequest(request(overrides, key), test.service);
		expect(response.status).toBe(400);
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM review_notification_receipts').get()).toEqual({ count: 0 });
		sqlite.close();
	});

	it('returns a successful duplicate result without a second visible notification', async () => {
		const sqlite = database(); const db = d1Database(sqlite); const test = receiver(db);
		expect((await handleReviewNotificationRequest(request(), test.service)).status).toBe(200);
		const duplicate = await handleReviewNotificationRequest(request(), test.service);
		expect(duplicate.status).toBe(200);
		expect(await duplicate.json()).toEqual({ state: 'duplicate' });
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM editorial_notifications').get()).toEqual({ count: 1 });
		expect(sqlite.prepare('SELECT attempt_count FROM review_notification_receipts').get()).toEqual({ attempt_count: 1 });
		sqlite.close();
	});

	it('uses the same validated delivery service in-process without a network fetch', async () => {
		const sqlite = database(); const before = sqlite.prepare('SELECT status, headline, updated_at FROM stories WHERE id = ?').get('story-1');
		const db = d1Database(sqlite); const test = receiver(db);
		const notifier = new InternalReviewNotifier(test.service, 'https://example.test');
		const notification = {
			batchId: 'batch-1', stage: 'TRIAGE' as const, kind: 'INITIAL' as const,
			message: 'Tomorrow-ish has 1 new intake ready for editorial triage.',
			reviewUrl: 'https://example.test/editorial/batches/batch-1/triage',
			idempotencyKey: 'editorial-review:batch-1:TRIAGE:INITIAL',
		};

		await notifier.send(notification);
		await notifier.send(notification);

		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM review_notification_receipts').get()).toEqual({ count: 1 });
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM editorial_notifications').get()).toEqual({ count: 1 });
		expect(sqlite.prepare('SELECT attempt_count FROM review_notification_receipts').get()).toEqual({ attempt_count: 1 });
		expect(sqlite.prepare('SELECT status, headline, updated_at FROM stories WHERE id = ?').get('story-1')).toEqual(before);
		sqlite.close();
	});

	it('shares exact URL and payload validation between HTTP and internal dispatch', async () => {
		const sqlite = database(); const db = d1Database(sqlite); const test = receiver(db);
		const notifier = new InternalReviewNotifier(test.service, 'https://example.test');
		await expect(notifier.send({
			batchId: 'batch-1', stage: 'TRIAGE', kind: 'INITIAL',
			message: 'Tomorrow-ish has 1 new intake ready for editorial triage.',
			reviewUrl: 'https://attacker.example/editorial/batches/batch-1/triage',
			idempotencyKey: 'editorial-review:batch-1:TRIAGE:INITIAL',
		})).rejects.toMatchObject({ classification: 'REJECTED' } satisfies Partial<ReviewNotificationError>);
		expect((await handleReviewNotificationRequest(request({
			reviewUrl: 'https://attacker.example/editorial/batches/batch-1/triage',
		}), test.service)).status).toBe(400);
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM review_notification_receipts').get()).toEqual({ count: 0 });
		sqlite.close();
	});

	it('records an isolated delivery failure and safely delivers one notification on retry', async () => {
		const sqlite = database(); const db = d1Database(sqlite);
		const failing: EditorialNotificationDeliveryPort = { deliver: vi.fn(async () => { throw new Error('inbox unavailable'); }) };
		const failed = receiver(db, failing);
		const failureResponse = await handleReviewNotificationRequest(request(), failed.service);
		expect(failureResponse.status).toBe(503);
		expect(await failed.receipts.find('editorial-review:batch-1:TRIAGE:INITIAL')).toMatchObject({
			status: 'FAILED', failureClassification: 'INTERNAL_INBOX_WRITE_FAILED', attemptCount: 1,
		});

		const retried = receiver(db);
		const retryResponse = await handleReviewNotificationRequest(request(), retried.service);
		expect(retryResponse.status).toBe(200);
		expect(await retried.receipts.find('editorial-review:batch-1:TRIAGE:INITIAL')).toMatchObject({
			status: 'DELIVERED', attemptCount: 2,
		});
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM editorial_notifications').get()).toEqual({ count: 1 });
		sqlite.close();
	});

	it('cannot mutate editorial or story state', async () => {
		const sqlite = database(); const before = sqlite.prepare('SELECT status, headline, updated_at FROM stories WHERE id = ?').get('story-1');
		const db = d1Database(sqlite); const test = receiver(db);
		expect((await handleReviewNotificationRequest(request(), test.service)).status).toBe(200);
		expect(sqlite.prepare('SELECT status, headline, updated_at FROM stories WHERE id = ?').get('story-1')).toEqual(before);
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM editorial_workflow_events').get()).toEqual({ count: 0 });
		sqlite.close();
	});

	it('rejects a valid-shaped event unless its reminder currently owns a delivery claim', async () => {
		const sqlite = database(); sqlite.exec("UPDATE editorial_stage_reminders SET claim_kind = NULL, claim_token = NULL, claimed_at = NULL");
		const db = d1Database(sqlite); const test = receiver(db);
		expect((await handleReviewNotificationRequest(request(), test.service)).status).toBe(403);
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM editorial_notifications').get()).toEqual({ count: 0 });
		sqlite.close();
	});
});
