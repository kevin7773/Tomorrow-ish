import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	validateBaselineTransition,
	validateGeneratedConfiguration,
	validateLiveSnapshot,
} from '../scripts/release/release-safety.mjs';

const canonicalBaseline = JSON.parse(readFileSync('release/production-baseline.json', 'utf8'));
const canonicalConfig = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
const boundary = '2026-10-15T12:00:00.000Z';
const roots: string[] = [];
const generationGates = [
	'MODEL_BUDGET_ADMISSION_ENABLED', 'MODEL_GENERATION_ENABLED',
	'EDITORIAL_WORKFLOW_GENERATION_ENABLED', 'EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED',
	'IMAGE_GENERATION_ENABLED',
];

type Stage = 'disabled' | 'notifications' | 'generation-acceptance' | 'publication' | 'routine';

function vars(stage: Stage) {
	const result = structuredClone(canonicalBaseline.requiredVars);
	for (const gate of [...generationGates, 'EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED',
		'EDITORIAL_AUTOMATED_PUBLICATION_ENABLED']) result[gate] = 'false';
	delete result.EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE;
	if (stage !== 'disabled') result.EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED = 'true';
	if (['generation-acceptance', 'routine'].includes(stage)) {
		for (const gate of generationGates) result[gate] = 'true';
		result.EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE = boundary;
	}
	if (['publication', 'routine'].includes(stage)) result.EDITORIAL_AUTOMATED_PUBLICATION_ENABLED = 'true';
	return result;
}

function baseline(stage: Stage) {
	return { ...structuredClone(canonicalBaseline), requiredVars: vars(stage) };
}

function contract(from: Stage, to: Stage) {
	const previous = vars(from);
	const target = vars(to);
	const allowedVariableChanges: Record<string, { from: string | null; to: string | null }> = {};
	for (const name of [...new Set([...Object.keys(previous), ...Object.keys(target)])].sort()) {
		const left = Object.hasOwn(previous, name) ? previous[name] : null;
		const right = Object.hasOwn(target, name) ? target[name] : null;
		if (left !== right) allowedVariableChanges[name] = { from: left, to: right };
	}
	return { name: `${from}-to-${to}`, automationCapabilityTransition: { from, to }, allowedVariableChanges };
}

function snapshot(stage: Stage) {
	const target = baseline(stage);
	return {
		capturedAt: new Date().toISOString(), accountId: target.accountId, workerName: target.workerName,
		d1: target.d1, r2: target.r2, assets: target.assets, workersDev: false, previewUrls: false,
		routes: target.routes, crons: target.crons, vars: target.requiredVars,
		secretNames: target.requiredSecrets,
	};
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('production automation activation contract', () => {
	it.each([
		['disabled', 'notifications'], ['notifications', 'disabled'],
		['notifications', 'generation-acceptance'], ['generation-acceptance', 'notifications'],
		['generation-acceptance', 'publication'], ['generation-acceptance', 'disabled'],
		['notifications', 'publication'], ['publication', 'notifications'],
		['publication', 'routine'], ['routine', 'publication'],
		['notifications', 'routine'], ['routine', 'notifications'],
		['publication', 'disabled'], ['routine', 'disabled'],
	] as [Stage, Stage][])('validates exact %s -> %s transition and target state', (from, to) => {
		const transition = validateBaselineTransition(baseline(from), baseline(to), contract(from, to));
		expect(transition.automationCapabilities).toMatchObject({ previous: { stage: from }, target: { stage: to } });
		const config = { ...structuredClone(canonicalConfig), vars: vars(to) };
		expect(() => validateGeneratedConfiguration(config, baseline(to),
			{ automationCapabilities: transition.automationCapabilities!.target })).not.toThrow();
		expect(() => validateLiveSnapshot(snapshot(to), baseline(to), { now: new Date(), liveState: 'target',
			transition, automationCapabilities: transition.automationCapabilities!.target })).not.toThrow();
	});

	it('keeps normal validation fully disabled and rejects enabled targets without policy', () => {
		expect(() => validateGeneratedConfiguration(canonicalConfig, canonicalBaseline)).not.toThrow();
		const target = baseline('notifications');
		const config = { ...structuredClone(canonicalConfig), vars: target.requiredVars };
		expect(() => validateGeneratedConfiguration(config, target)).toThrow(/fully disabled|disabled state/);
	});

	it('rejects missing or malformed boundaries, partial generation gates, extra drift, and unreviewed edges', () => {
		const missing = baseline('generation-acceptance');
		delete missing.requiredVars.EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE;
		expect(() => validateBaselineTransition(baseline('notifications'), missing,
			{ ...contract('notifications', 'generation-acceptance'), allowedVariableChanges: {
				...contract('notifications', 'generation-acceptance').allowedVariableChanges,
				EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE: { from: null, to: null },
			} })).toThrow();
		const partial = baseline('generation-acceptance');
		partial.requiredVars.IMAGE_GENERATION_ENABLED = 'false';
		expect(() => validateBaselineTransition(baseline('notifications'), partial,
			contract('notifications', 'generation-acceptance'))).toThrow();
		const drift = baseline('notifications');
		drift.requiredVars.ADS_ENABLED = 'true';
		expect(() => validateBaselineTransition(baseline('disabled'), drift,
			contract('disabled', 'notifications'))).toThrow();
		expect(() => validateBaselineTransition(baseline('disabled'), baseline('routine'),
			contract('disabled', 'routine'))).toThrow(/approved staged edge/);
	});

	it('prepares exact private configs and contracts without changing the canonical disabled artifact', async () => {
		const root = await mkdtemp(join(tmpdir(), 'automation-transition-'));
		roots.push(root);
		const server = join(root, 'server');
		const privateDir = join(root, 'private');
		await mkdir(server, { recursive: true });
		await writeFile(join(server, 'wrangler.json'), JSON.stringify(canonicalConfig));
		const run = spawnSync(process.execPath, ['scripts/release/prepare-automation-transition.mjs',
			'--from', 'notifications', '--to', 'generation-acceptance', '--not-before', boundary,
			'--server-dir', server, '--private-dir', privateDir], { encoding: 'utf8' });
		expect(run.status).toBe(0);
		const target = JSON.parse(await readFile(join(privateDir, 'production-baseline.target.json'), 'utf8'));
		const exactContract = JSON.parse(await readFile(join(privateDir, 'transition-contract.json'), 'utf8'));
		expect(target.requiredVars.EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE).toBe(boundary);
		expect(exactContract.allowedVariableChanges.EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE)
			.toEqual({ from: null, to: boundary });
		const paused = JSON.parse(await readFile(join(server, 'wrangler.automation.pause.json'), 'utf8'));
		const restored = JSON.parse(await readFile(join(server, 'wrangler.automation.restore.json'), 'utf8'));
		expect(paused.triggers.crons).toEqual([]);
		expect(restored.triggers.crons).toEqual(canonicalBaseline.crons);
		expect(canonicalConfig.vars.EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED).toBe('false');
	});
});
