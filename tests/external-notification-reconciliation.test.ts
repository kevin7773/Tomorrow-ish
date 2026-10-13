import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1ExternalReviewNotificationRepository } from '../src/data/external-review-notification-repository';
import type { ReviewNotification } from '../src/notifications/review-notifier';
import { ExternalNotificationReconciliationService } from '../src/services/external-notification-reconciliation-service';

const NOW = '2026-10-13T12:00:00.000Z';
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

function database(): { sqlite: DatabaseSync; repository: D1ExternalReviewNotificationRepository; notification: ReviewNotification } {
	const sqlite = new DatabaseSync(':memory:');
	for (const filename of readdirSync(join(process.cwd(), 'migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
		sqlite.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
	}
	sqlite.exec(`INSERT INTO automation_runs (id,trigger_kind,status,started_at,completed_at)
		VALUES ('batch-1','SCHEDULED','SUCCEEDED','${NOW}','${NOW}');
		INSERT INTO editorial_batches (id,item_count,created_at) VALUES ('batch-1',3,'${NOW}');
		INSERT INTO editorial_stage_reminders (batch_id,stage,created_at,claim_kind,claim_token,claimed_at)
		VALUES ('batch-1','FINAL_REVIEW','${NOW}','INITIAL','claim','${NOW}');`);
	return { sqlite, repository: new D1ExternalReviewNotificationRepository(d1Database(sqlite)), notification: {
		batchId: 'batch-1', stage: 'FINAL_REVIEW', kind: 'INITIAL', message: 'Ready', reviewUrl: null,
		idempotencyKey: 'editorial-review:batch-1:FINAL_REVIEW:INITIAL',
	} };
}

async function prepare(status: 'AMBIGUOUS' | 'FAILED') {
	const test = database();
	const key = `external-review:v1:${test.notification.idempotencyKey}`;
	expect(await test.repository.reserve(test.notification, key, 'owner', NOW)).toBe('ACQUIRED');
	if (status === 'AMBIGUOUS') await test.repository.markAmbiguous(key, 'owner', NOW, 'NETWORK', null, null);
	else await test.repository.markFailed(key, 'owner', NOW, 'REJECTED', 400, 'request-1');
	return { ...test, key };
}

describe('governed external notification reconciliation', () => {
	it('records confirmed delivery as immutable evidence without sending again', async () => {
		const test = await prepare('AMBIGUOUS');
		const service = new ExternalNotificationReconciliationService(test.repository, () => NOW, () => 'recon-1');
		await service.reconcile({ email: 'Editor@Tomorrow-ish.news' }, { operationKey: test.key,
			decision: 'CONFIRMED_DELIVERED', evidenceReference: 'Destination log delivery-123', confirmation: 'CONFIRM DELIVERED' });
		await expect(service.reconcile({ email: 'Editor@Tomorrow-ish.news' }, { operationKey: test.key,
			decision: 'CONFIRMED_DELIVERED', evidenceReference: 'Duplicate review', confirmation: 'CONFIRM DELIVERED' }))
			.rejects.toMatchObject({ code: 'conflict' });
		expect(await test.repository.find(test.key)).toMatchObject({ status: 'DELIVERED' });
		expect(test.sqlite.prepare('SELECT COUNT(*) AS count FROM external_review_notification_reconciliations').get())
			.toEqual({ count: 1 });
		expect(test.sqlite.prepare(`SELECT decision,evidence_reference,actor_email FROM external_review_notification_reconciliations`).get())
			.toEqual({ decision: 'CONFIRMED_DELIVERED', evidence_reference: 'Destination log delivery-123', actor_email: 'editor@tomorrow-ish.news' });
		expect(() => test.sqlite.prepare("DELETE FROM external_review_notification_reconciliations WHERE id='recon-1'").run())
			.toThrow(/cannot be deleted/);
		test.sqlite.close();
	});

	it('requires explicit evidence and state-compatible confirmation', async () => {
		const test = await prepare('AMBIGUOUS');
		const service = new ExternalNotificationReconciliationService(test.repository, () => NOW, () => 'recon-2');
		await expect(service.reconcile({ email: 'editor@example.com' }, { operationKey: test.key,
			decision: 'CONFIRMED_FAILED', evidenceReference: 'Checked destination logs', confirmation: 'wrong' }))
			.rejects.toThrow(/CONFIRM FAILED/);
		await expect(service.reconcile(null, { operationKey: test.key, decision: 'CONFIRMED_FAILED',
			evidenceReference: 'Checked destination logs', confirmation: 'CONFIRM FAILED' })).rejects.toThrow(/authenticated/);
		await service.reconcile({ email: 'editor@example.com' }, { operationKey: test.key,
			decision: 'CONFIRMED_FAILED', evidenceReference: 'Destination confirms no delivery', confirmation: 'CONFIRM FAILED' });
		expect(await test.repository.find(test.key)).toMatchObject({ status: 'FAILED', failureClassification: 'OPERATOR_CONFIRMED_NOT_DELIVERED' });
		test.sqlite.close();
	});

	it('permits a failed delivery to be manually delivered only with the original idempotency key', async () => {
		const test = await prepare('FAILED');
		const service = new ExternalNotificationReconciliationService(test.repository, () => NOW, () => 'recon-3');
		await service.reconcile({ email: 'editor@example.com' }, { operationKey: test.key,
			decision: 'MANUALLY_DELIVERED', evidenceReference: `Sent externally with ${test.notification.idempotencyKey}`,
			confirmation: 'CONFIRM MANUAL DELIVERY' });
		expect(await test.repository.find(test.key)).toMatchObject({ status: 'DELIVERED' });
		expect((await test.repository.listForInvestigation(10))).toHaveLength(0);
		test.sqlite.close();
	});
});
