import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	validateBaselineTransition,
	validateGeneratedConfiguration,
	validateLiveSnapshot,
} from '../scripts/release/release-safety.mjs';

const roots: string[] = [];
const authorizationId = 'acceptance-test:synthetic-authorization-0001';
const authorizationIdSha256 = createHash('sha256').update(authorizationId).digest('hex');
const canonicalBaseline = JSON.parse(readFileSync('release/production-baseline.json', 'utf8'));
const canonicalConfig = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));

function contract(direction: 'enable' | 'disable') {
	return direction === 'enable' ? {
		name: 'synthetic-enable', notificationAcceptanceTestTransition: 'enable', allowedVariableChanges: {
			EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID:
				{ from: '', toSha256: authorizationIdSha256 },
			EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED: { from: 'false', to: 'true' },
		},
	} : {
		name: 'synthetic-disable', notificationAcceptanceTestTransition: 'disable', allowedVariableChanges: {
			EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID:
				{ fromSha256: authorizationIdSha256, to: '' },
			EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED: { from: 'true', to: 'false' },
		},
	};
}

function enabledBaseline(id = authorizationId) {
	const target = structuredClone(canonicalBaseline);
	target.requiredVars.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED = 'true';
	target.requiredVars.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID = id;
	return target;
}

afterEach(async () => {
	const { rm } = await import('node:fs/promises');
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('one-use notification acceptance release transition', () => {
	it('permits only the hash-pinned two-variable enable and exact reversal', () => {
		const target = enabledBaseline();
		const enable = validateBaselineTransition(canonicalBaseline, target, contract('enable'));
		expect(enable.notificationAcceptanceTest).toEqual({
			transition: 'enable',
			previous: { mode: 'disabled', authorizationIdSha256: null },
			target: { mode: 'enabled', authorizationIdSha256 },
		});
		expect(validateBaselineTransition(target, canonicalBaseline, contract('disable'))
			.notificationAcceptanceTest?.transition).toBe('disable');
	});

	it('keeps ordinary target validation fail-closed without the reviewed transition policy', () => {
		const target = enabledBaseline();
		const config = { ...structuredClone(canonicalConfig), vars: target.requiredVars };
		expect(() => validateGeneratedConfiguration(config, target)).toThrow(/acceptance-test/);
		const transition = validateBaselineTransition(canonicalBaseline, target, contract('enable'));
		expect(() => validateGeneratedConfiguration(config, target,
			{ notificationAcceptanceTest: transition.notificationAcceptanceTest!.target })).not.toThrow();
	});

	it('rejects a changed authorization, missing contract, extra drift, or enabled routine gate', () => {
		expect(() => validateBaselineTransition(canonicalBaseline,
			enabledBaseline('acceptance-test:another-authorization-0002'), contract('enable')))
			.toThrow(/fingerprint/);
		expect(() => validateBaselineTransition(canonicalBaseline, enabledBaseline(), {
			...contract('enable'), notificationAcceptanceTestTransition: undefined,
		})).toThrow(/retained as false/);
		const drifted = enabledBaseline();
		drifted.requiredVars.EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED = 'true';
		expect(() => validateBaselineTransition(canonicalBaseline, drifted, contract('enable')))
			.toThrow(/actual variable changes|must remain false/);
	});

	it('requires an explicit enabled policy for live target validation', () => {
		const target = enabledBaseline();
		const transition = validateBaselineTransition(canonicalBaseline, target, contract('enable'));
		const snapshot = {
			capturedAt: new Date().toISOString(), accountId: target.accountId, workerName: target.workerName,
			d1: target.d1, r2: target.r2, assets: target.assets, workersDev: false, previewUrls: false,
			routes: target.routes, crons: target.crons, vars: target.requiredVars,
			secretNames: target.requiredSecrets,
		};
		expect(() => validateLiveSnapshot(snapshot, target,
			{ now: new Date(), liveState: 'target' })).toThrow(/acceptance-test/);
		expect(() => validateLiveSnapshot(snapshot, target, { now: new Date(), liveState: 'target',
			notificationAcceptanceTest: transition.notificationAcceptanceTest!.target })).not.toThrow();
	});

	it('prepares protected artifacts without echoing the authorization and fails closed on bad input', async () => {
		const root = await mkdtemp(join(tmpdir(), 'acceptance-release-'));
		roots.push(root);
		const server = join(root, 'server');
		const privateDir = join(root, 'private');
		await mkdir(server, { recursive: true });
		await writeFile(join(server, 'wrangler.json'), JSON.stringify(canonicalConfig));
		const enablePath = join(root, 'enable.json');
		const disablePath = join(root, 'disable.json');
		await writeFile(enablePath, JSON.stringify(contract('enable')));
		await writeFile(disablePath, JSON.stringify(contract('disable')));
		const args = ['scripts/release/prepare-notification-acceptance-transition.mjs',
			'--server-dir', server, '--private-dir', privateDir,
			'--enable-contract', enablePath, '--disable-contract', disablePath];
		const ok = spawnSync(process.execPath, args,
			{ input: JSON.stringify({ authorizationId }), encoding: 'utf8' });
		expect(ok.status).toBe(0);
		expect(`${ok.stdout}${ok.stderr}`).not.toContain(authorizationId);
		const target = JSON.parse(await readFile(join(privateDir,
			'production-baseline.acceptance-enabled.json'), 'utf8'));
		expect(target.requiredVars.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID).toBe(authorizationId);
		for (const gate of ['MODEL_GENERATION_ENABLED', 'MODEL_BUDGET_ADMISSION_ENABLED',
			'EDITORIAL_WORKFLOW_GENERATION_ENABLED', 'EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED',
			'IMAGE_GENERATION_ENABLED', 'EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED',
			'EDITORIAL_AUTOMATED_PUBLICATION_ENABLED']) {
			expect(target.requiredVars[gate]).toBe('false');
		}
		const paused = JSON.parse(await readFile(join(server, 'wrangler.acceptance.pause.json'), 'utf8'));
		const restored = JSON.parse(await readFile(join(server, 'wrangler.acceptance.restore.json'), 'utf8'));
		expect(paused.triggers.crons).toEqual([]);
		expect(restored.triggers.crons).toEqual(canonicalBaseline.crons);
		const badSecret = 'acceptance-test:secret-that-must-not-leak';
		const failed = spawnSync(process.execPath, args,
			{ input: JSON.stringify({ authorizationId: badSecret }), encoding: 'utf8' });
		expect(failed.status).not.toBe(0);
		expect(`${failed.stdout}${failed.stderr}`).not.toContain(badSecret);
		await expect(readFile(join(server, 'wrangler.acceptance.json'), 'utf8')).rejects.toThrow();
	});
});
