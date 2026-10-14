import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { D1NotificationAcceptanceTestRepository } from '../src/data/notification-acceptance-test-repository';
import { handleResendWebhookRequest } from '../src/notifications/resend-email-endpoint';
import {
	ResendEmailProvider,
	ResendSubmissionError,
	sha256Hex,
	type EditorialEmail,
	type ResendEmailConfiguration,
	type ResendSubmissionResult,
} from '../src/notifications/resend-email';
import {
	NOTIFICATION_ACCEPTANCE_TEST_CONFIRMATION,
	NotificationAcceptanceTestService,
	type NotificationAcceptanceTestEnvironment,
} from '../src/services/notification-acceptance-test-service';

const NOW = '2026-10-13T22:00:00.000Z';
const AUTHORIZATION_ID = 'acceptance-2026-10-13-0001';
const IDEMPOTENCY_KEY = `editorial-notification-acceptance-test:${AUTHORIZATION_ID}`;
const SECRET_BYTES = '0123456789abcdef0123456789abcdef';
const configuration: ResendEmailConfiguration = {
	apiKey: 're_test_key_with_at_least_twenty_characters',
	webhookSigningSecret: `whsec_${btoa(SECRET_BYTES)}`,
	toEmail: 'editor@gmail.com',
	fromEmail: 'editorial@tomorrow-ish.news',
};
const enabled = {
	EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED: 'true',
	EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID: AUTHORIZATION_ID,
};
const execute = Symbol('execute');
type ExecutableStatement = D1PreparedStatement & { [execute]: () => D1Result };

function d1Database(sqlite: DatabaseSync): D1Database {
	return {
		prepare(query: string) { let bindings: unknown[] = []; const statement = {
			bind(...values: unknown[]) { bindings = values; return statement; },
			async first<T>() { return (sqlite.prepare(query).get(...bindings as never[]) as T | undefined) ?? null; },
			async all<T>() { return { success: true, results: sqlite.prepare(query).all(...bindings as never[]) as T[] } as D1Result<T>; },
			async run<T>() { return statement[execute]() as D1Result<T>; },
			[execute]() { const result = sqlite.prepare(query).run(...bindings as never[]); return {
				success: true, results: [], meta: { changes: Number(result.changes) },
			} as unknown as D1Result; },
		}; return statement as unknown as D1PreparedStatement; },
		async batch<T>(statements: D1PreparedStatement[]) {
			sqlite.exec('BEGIN IMMEDIATE');
			try {
				const results = statements.map((statement) => (statement as ExecutableStatement)[execute]());
				sqlite.exec('COMMIT');
				return results as D1Result<T>[];
			} catch (error) { sqlite.exec('ROLLBACK'); throw error; }
		},
	} as unknown as D1Database;
}

function harness() {
	const sqlite = new DatabaseSync(':memory:');
	for (const filename of readdirSync(join(process.cwd(), 'migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
		sqlite.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
	}
	const repository = new D1NotificationAcceptanceTestRepository(d1Database(sqlite));
	let id = 0;
	return { sqlite, repository, createId: () => `acceptance-event-${++id}` };
}

function service(test: ReturnType<typeof harness>, providerFactory: () => {
	submit: (idempotencyKey: string, idempotencyHash: string, email: EditorialEmail) => Promise<ResendSubmissionResult>;
}, environment: NotificationAcceptanceTestEnvironment = enabled) {
	return new NotificationAcceptanceTestService(test.repository, providerFactory, configuration,
		environment, () => NOW, test.createId);
}

const input = { authorizationId: AUTHORIZATION_ID, confirmation: NOTIFICATION_ACCEPTANCE_TEST_CONFIRMATION };
const identity = { email: 'EDITOR@EXAMPLE.COM' };

async function signature(body: string, eventId: string, timestamp: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET_BYTES),
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signed = await crypto.subtle.sign('HMAC', key,
		new TextEncoder().encode(`${eventId}.${timestamp}.${body}`));
	let binary = '';
	for (const byte of new Uint8Array(signed)) binary += String.fromCharCode(byte);
	return `v1,${btoa(binary)}`;
}

async function callback(type = 'email.delivered', eventId = 'acceptance_event_1',
	providerEmailId = 'email_acceptance_1') {
	const timestamp = String(Math.floor(Date.parse(NOW) / 1000));
	const body = JSON.stringify({ type, created_at: NOW, data: {
		email_id: providerEmailId, to: [configuration.toEmail], from: configuration.fromEmail,
		subject: 'Tomorrow-ish: Notification Delivery Acceptance Test', created_at: NOW,
		tags: { notification_key: await sha256Hex(IDEMPOTENCY_KEY) },
	} });
	return new Request('https://tomorrow-ish.news/api/internal/resend-delivery-webhook', {
		method: 'POST', headers: { 'content-type': 'application/json', 'svix-id': eventId,
			'svix-timestamp': timestamp, 'svix-signature': await signature(body, eventId, timestamp) }, body,
	});
}

describe('governed one-time notification acceptance test', () => {
	it('keeps the send action behind editorial authentication and constructs no provider before identity', () => {
		const route = readFileSync('src/pages/editorial/actions/notification-acceptance-test.ts', 'utf8');
		expect(route).toContain('export const POST');
		expect(route.indexOf('requireEditor(context)')).toBeGreaterThan(-1);
		expect(route.indexOf('requireEditor(context)')).toBeLessThan(route.indexOf('new ResendEmailProvider'));
		expect(route).not.toContain('export const GET');
	});

	it('fails closed while disabled or unauthorized before reservation and provider construction', async () => {
		const test = harness(); const factory = vi.fn();
		for (const environment of [
			{},
			{ EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED: 'false',
				EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID: AUTHORIZATION_ID },
			{ EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED: 'true',
				EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID: '' },
			{ EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED: 'unexpected',
				EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID: AUTHORIZATION_ID },
		]) await expect(service(test, factory as never, environment).submit(identity, input)).rejects.toThrow();
		await expect(service(test, factory as never).submit(null, input)).rejects.toThrow(/authenticated editor/);
		await expect(service(test, factory as never).submit(identity,
			{ ...input, authorizationId: 'different-authorization-id' })).rejects.toThrow(/does not match/);
		await expect(service(test, factory as never).submit(identity,
			{ ...input, confirmation: 'SEND' })).rejects.toThrow(/SEND ONE TEST EMAIL/);
		expect(factory).not.toHaveBeenCalled();
		expect(test.sqlite.prepare('SELECT COUNT(*) AS count FROM editorial_notification_acceptance_tests').get())
			.toEqual({ count: 0 });
		test.sqlite.close();
	});

	it('reserves before provider construction and submits exactly once across duplicate and concurrent actions', async () => {
		const test = harness();
		const provider = { submit: vi.fn(async (_key: string, _hash: string, email: { subject: string; text: string }) => {
			expect(email.subject).toBe('Tomorrow-ish: Notification Delivery Acceptance Test');
			expect(email.text).toContain('TEST MESSAGE — no editorial action is required.');
			return { providerEmailId: 'email_acceptance_1', responseStatus: 200 };
		}) };
		const factory = vi.fn(() => {
			expect(test.sqlite.prepare(`SELECT status,purpose,actor_email
				FROM editorial_notification_acceptance_tests`).get()).toEqual({
				status: 'PENDING', purpose: 'ACCEPTANCE_TEST', actor_email: 'editor@example.com',
			});
			return provider;
		});
		const worker = service(test, factory);
		const [first, duplicate] = await Promise.all([
			worker.submit(identity, input), worker.submit(identity, input),
		]);
		expect([first.deliveryState, duplicate.deliveryState]).toEqual(['PENDING', 'PENDING']);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(provider.submit).toHaveBeenCalledTimes(1);
		expect((await worker.submit(identity, input)).deliveryState).toBe('PENDING');
		expect(provider.submit).toHaveBeenCalledTimes(1);
		expect(test.sqlite.prepare('SELECT COUNT(*) AS count FROM external_review_notification_deliveries').get())
			.toEqual({ count: 0 });
		expect(test.sqlite.prepare('SELECT COUNT(*) AS count FROM resend_email_submissions').get())
			.toEqual({ count: 0 });
		expect(test.sqlite.prepare(`SELECT COUNT(*) AS count
			FROM editorial_notification_acceptance_test_events`).get()).toEqual({ count: 2 });
		test.sqlite.close();
	});

	it('does not resubmit failed or ambiguous outcomes and keeps lost responses protected', async () => {
		for (const [classification, expected] of [
			['PROVIDER_AMBIGUOUS', 'AMBIGUOUS'], ['PROVIDER_REJECTED', 'FAILED'],
		] as const) {
			const test = harness();
			const provider = { submit: vi.fn(async () => { throw new ResendSubmissionError(classification,
				classification === 'PROVIDER_REJECTED' ? 422 : null); }) };
			const worker = service(test, () => provider);
			expect(await worker.submit(identity, input)).toMatchObject({ deliveryState: expected });
			expect(await worker.submit(identity, input)).toMatchObject({ deliveryState: expected });
			expect(provider.submit).toHaveBeenCalledTimes(1);
			test.sqlite.close();
		}
	});

	it('fails closed on missing credentials after reservation without contacting Resend', async () => {
		const test = harness(); const fetcher = vi.fn();
		const invalid = { ...configuration, apiKey: '' };
		const worker = new NotificationAcceptanceTestService(test.repository,
			() => new ResendEmailProvider(invalid, fetcher), invalid, enabled, () => NOW, test.createId);
		expect(await worker.submit(identity, input)).toMatchObject({
			deliveryState: 'FAILED', classification: 'PROVIDER_CONFIGURATION',
		});
		expect(fetcher).not.toHaveBeenCalled();
		expect((await test.repository.find(IDEMPOTENCY_KEY))?.status).toBe('FAILED');
		test.sqlite.close();
	});

	it('allows a signed callback to resolve the original ambiguous attempt and deduplicates replay', async () => {
		const test = harness();
		const provider = { submit: vi.fn(async () => { throw new ResendSubmissionError('PROVIDER_AMBIGUOUS', null); }) };
		const worker = service(test, () => provider);
		expect((await worker.submit(identity, input)).deliveryState).toBe('AMBIGUOUS');
		const request = await callback();
		expect((await handleResendWebhookRequest(request, worker, configuration, () => new Date(NOW))).status).toBe(200);
		expect(await test.repository.find(IDEMPOTENCY_KEY)).toMatchObject({
			status: 'DELIVERED', providerEmailId: 'email_acceptance_1',
		});
		const replay = await callback();
		expect(await (await handleResendWebhookRequest(replay, worker, configuration, () => new Date(NOW))).json())
			.toMatchObject({ state: 'duplicate' });
		expect(provider.submit).toHaveBeenCalledTimes(1);
		test.sqlite.close();
	});

	it('rejects invalid callbacks without state changes and preserves immutable evidence', async () => {
		const test = harness();
		const provider = { submit: vi.fn(async () => ({ providerEmailId: 'email_acceptance_1', responseStatus: 200 })) };
		const worker = service(test, () => provider);
		await worker.submit(identity, input);
		const invalid = await callback();
		invalid.headers.set('svix-signature', 'v1,invalid');
		expect((await handleResendWebhookRequest(invalid, worker, configuration, () => new Date(NOW))).status).toBe(401);
		expect((await test.repository.find(IDEMPOTENCY_KEY))?.status).toBe('PENDING');
		expect(test.sqlite.prepare(`SELECT COUNT(*) AS count FROM editorial_notification_acceptance_test_events`).get())
			.toEqual({ count: 2 });
		expect(() => test.sqlite.prepare('DELETE FROM editorial_notification_acceptance_tests').run())
			.toThrow(/cannot be deleted/);
		expect(() => test.sqlite.prepare(`UPDATE editorial_notification_acceptance_test_events
			SET actor_email='attacker@example.com'`).run()).toThrow(/immutable/);
		test.sqlite.close();
	});

	it('fixes the provider recipient to configuration and never includes routine editorial content', async () => {
		const test = harness(); let submittedBody: Record<string, unknown> | null = null;
		const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			submittedBody = JSON.parse(String(init?.body));
			return Response.json({ id: 'email_acceptance_1' });
		});
		const worker = new NotificationAcceptanceTestService(test.repository,
			() => new ResendEmailProvider(configuration, fetcher), configuration,
			enabled, () => NOW, test.createId);
		expect((await worker.submit(identity, input)).deliveryState).toBe('PENDING');
		expect(submittedBody).toMatchObject({ to: ['editor@gmail.com'],
			subject: 'Tomorrow-ish: Notification Delivery Acceptance Test' });
		expect(JSON.stringify(submittedBody)).not.toContain('batch-email');
		expect(JSON.stringify(submittedBody)).not.toContain('finished stories');
		test.sqlite.close();
	});
});
