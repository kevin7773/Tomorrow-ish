import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createCronConfiguration,
	validateDeployedModuleInventory,
	validateBaselineTransition,
	validateDisabledVersionSnapshot,
	validateDryRunPackage,
	validateGeneratedConfiguration,
	validateLiveSnapshot,
	validateReviewedModelBudgetVariables,
	validateUploadedVersion,
} from '../scripts/release/release-safety.mjs';

const roots: string[] = [];
const snapshotNow = new Date('2026-10-12T22:00:00.000Z');
afterEach(async () => {
	const { rm } = await import('node:fs/promises');
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const baseline = {
	accountId: 'account-1', workerName: 'worker-1', main: 'entry.mjs', workersDev: false, previewUrls: false,
	compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'],
	routes: [{ pattern: 'example.com', custom_domain: true }], crons: ['0 13 * * *', '0 21 * * *', '*/5 * * * *'],
	assets: { binding: 'ASSETS', directory: '../client' },
	d1: [{ binding: 'DB', database_name: 'production', database_id: 'db-1' }],
	r2: [{ binding: 'IMAGES', bucket_name: 'images' }], requiredSecrets: ['SECRET_A'],
	requiredVars: { MODEL_GENERATION_ENABLED: 'false', EDITORIAL_WORKFLOW_GENERATION_ENABLED: 'false',
		EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED: 'false', EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED: 'false',
		EDITORIAL_AUTOMATED_PUBLICATION_ENABLED: 'false',
		IMAGE_GENERATION_ENABLED: 'false', EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY: '',
		IMAGE_ATTEMPT_BUDGET_MICRO_USD: '50000', IMAGE_BATCH_BUDGET_MICRO_USD: '150000',
		IMAGE_DAILY_BUDGET_MICRO_USD: '150000' },
};

const disabledVars = { MODEL_GENERATION_ENABLED: 'false', EDITORIAL_WORKFLOW_GENERATION_ENABLED: 'false',
	EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED: 'false', EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED: 'false',
	EDITORIAL_AUTOMATED_PUBLICATION_ENABLED: 'false',
	IMAGE_GENERATION_ENABLED: 'false', EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY: '',
	IMAGE_ATTEMPT_BUDGET_MICRO_USD: '50000', IMAGE_BATCH_BUDGET_MICRO_USD: '150000',
	IMAGE_DAILY_BUDGET_MICRO_USD: '150000' };

const budgetVars = {
	MODEL_BUDGET_ADMISSION_ENABLED: 'false',
	MODEL_NORMALIZE_MAX_COST_MICRO_USD: '50000',
	MODEL_CANDIDATES_MAX_COST_MICRO_USD: '50000',
	MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD: '60000',
	MODEL_ITEM_BUDGET_MICRO_USD: '170000',
	MODEL_BATCH_BUDGET_MICRO_USD: '510000',
	MODEL_DAILY_BUDGET_MICRO_USD: '510000',
};

const transitionContract = { name: 'phase-4b-model-budget-configuration', allowedVariableChanges: {
	MODEL_BUDGET_ADMISSION_ENABLED: { from: null, to: 'false' },
	MODEL_NORMALIZE_MAX_COST_MICRO_USD: { from: null, to: '50000' },
	MODEL_CANDIDATES_MAX_COST_MICRO_USD: { from: null, to: '50000' },
	MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD: { from: null, to: '60000' },
	MODEL_ITEM_BUDGET_MICRO_USD: { from: null, to: '170000' },
	MODEL_BATCH_BUDGET_MICRO_USD: { from: null, to: '510000' },
	MODEL_DAILY_BUDGET_MICRO_USD: { from: '1000000', to: '510000' },
	EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED: { from: null, to: 'false' },
} };

function config() {
	return { account_id: 'account-1', name: 'worker-1', topLevelName: 'worker-1', main: 'entry.mjs', no_bundle: true,
		compatibility_date: '2026-09-10', compatibility_flags: ['nodejs_compat'],
		workers_dev: false, preview_urls: false, routes: baseline.routes, triggers: { crons: baseline.crons },
		assets: baseline.assets, d1_databases: baseline.d1, r2_buckets: baseline.r2,
		vars: baseline.requiredVars, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] };
}

function liveSnapshot(overrides = {}) {
	return { capturedAt: '2026-10-12T21:55:00.000Z', accountId: 'account-1', workerName: 'worker-1', d1: baseline.d1, r2: baseline.r2,
		assets: baseline.assets, workersDev: false, previewUrls: false, routes: baseline.routes,
		crons: baseline.crons, secretNames: ['SECRET_A'], vars: disabledVars, ...overrides };
}

function validateLive(snapshot: ReturnType<typeof liveSnapshot>, paused = false) {
	return validateLiveSnapshot(snapshot, baseline, { paused, now: snapshotNow });
}

async function packageFixture(includeDependency = true) {
	const root = await mkdtemp(join(tmpdir(), 'release-safety-'));
	roots.push(root);
	const source = join(root, 'source');
	const output = join(root, 'output');
	await mkdir(join(source, 'chunks'), { recursive: true });
	await mkdir(join(output, 'chunks'), { recursive: true });
	await writeFile(join(source, 'entry.mjs'), 'import "./chunks/dependency.mjs";');
	await writeFile(join(source, 'chunks/dependency.mjs'), 'export const value = 1;');
	await writeFile(join(output, 'entry.mjs'), 'import "./chunks/dependency.mjs";');
	if (includeDependency) await writeFile(join(output, 'chunks/dependency.mjs'), 'export const value = 1;');
	return { source, output };
}

describe('production release safety', () => {
	it('validates the checked-in pre-budget to Phase 4E disabled transition exactly', () => {
		const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
		expect(validateBaselineTransition(
			read('release/production-baseline.pre-model-budget.json'),
			read('release/production-baseline.json'),
			read('release/model-budget-baseline-transition.json'),
		)).toMatchObject({ name: 'phase-4e-governed-editorial-automation-disabled' });
	});

	it('accepts genuinely absent legacy automation gates only in an explicitly reviewed previous state', () => {
		const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
		const previous = read('release/production-baseline.pre-model-budget.json');
		const target = read('release/production-baseline.json');
		const transition = validateBaselineTransition(
			previous,
			target,
			read('release/model-budget-baseline-transition.json'),
		);
		const snapshot = {
			capturedAt: '2026-10-12T21:55:00.000Z', accountId: previous.accountId,
			workerName: previous.workerName, d1: previous.d1, r2: previous.r2, assets: previous.assets,
			workersDev: false, previewUrls: false, routes: previous.routes, crons: previous.crons,
			secretNames: previous.requiredSecrets, vars: previous.requiredVars,
		};
		expect(() => validateLiveSnapshot(snapshot, previous,
			{ now: snapshotNow, liveState: 'previous', transition })).not.toThrow();
		expect(() => validateLiveSnapshot(snapshot, previous,
			{ now: snapshotNow, liveState: 'previous' })).toThrow(/ROUTINE_IMAGE_PREPARATION/);
		expect(() => validateLiveSnapshot(snapshot, previous,
			{ now: snapshotNow, liveState: 'target', transition })).toThrow(/ROUTINE_IMAGE_PREPARATION/);
	});

	it('requires exact contract authorization for every legacy-disabled gate introduction', () => {
		const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
		const previous = read('release/production-baseline.pre-model-budget.json');
		const target = read('release/production-baseline.json');
		const contract = read('release/model-budget-baseline-transition.json');
		delete contract.allowedVariableChanges.EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED;
		expect(() => validateBaselineTransition(previous, target, contract))
			.toThrow(/actual variable changes differ/);
	});

	it('requires every capability gate to be explicitly false in target mode', () => {
		const { EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED: _omitted, ...missingGateVars } = baseline.requiredVars;
		expect(() => validateLiveSnapshot(liveSnapshot({ vars: missingGateVars }), baseline,
			{ now: snapshotNow, liveState: 'target' })).toThrow(/variables differ|EXTERNAL_NOTIFICATIONS/);
		expect(() => validateLiveSnapshot(liveSnapshot({ vars: {
			...baseline.requiredVars, EDITORIAL_AUTOMATED_PUBLICATION_ENABLED: 'true',
		} }), baseline, { now: snapshotNow, liveState: 'target' }))
			.toThrow(/variables differ|AUTOMATED_PUBLICATION/);
		expect(() => validateLiveSnapshot(liveSnapshot({ vars: {
			...baseline.requiredVars, UNREVIEWED: 'false',
		} }), baseline, { now: snapshotNow, liveState: 'target' })).toThrow(/variables differ/);
	});

	it('detects a missing generated chunk in the Wrangler dry-run package', async () => {
		const fixture = await packageFixture(false);
		await expect(validateDryRunPackage(fixture.source, fixture.output, config())).rejects.toThrow(/dependency\.mjs/);
	});

	it('accepts a complete recursive module graph and package', async () => {
		const fixture = await packageFixture();
		await expect(validateDryRunPackage(fixture.source, fixture.output, config())).resolves.toMatchObject({ generatedModules: 2, packagedModules: 2 });
	});

	it('ignores import-looking text embedded in generated module strings', async () => {
		const fixture = await packageFixture();
		await writeFile(join(fixture.source, 'chunks/dependency.mjs'), 'export const value = `import "./not-a-module.js"`;');
		await writeFile(join(fixture.output, 'chunks/dependency.mjs'), 'export const value = `import "./not-a-module.js"`;');
		await expect(validateDryRunPackage(fixture.source, fixture.output, config())).resolves.toMatchObject({ generatedModules: 2, reachableModules: 2 });
	});

	it('fails closed on generated configuration drift', () => {
		expect(() => validateGeneratedConfiguration({ ...config(), d1_databases: [{ ...baseline.d1[0], database_id: 'wrong' }] }, baseline))
			.toThrow(/D1 binding identity/);
	});

	it('rejects the wrong authenticated account', () => {
		expect(() => validateLive(liveSnapshot({ accountId: 'wrong' })))
			.toThrow(/account/);
	});

	it('rejects the wrong Worker identity and stale snapshots', () => {
		expect(() => validateLive(liveSnapshot({ workerName: 'wrong' }))).toThrow(/Worker identity/);
		expect(() => validateLive(liveSnapshot({ capturedAt: '2026-10-12T21:40:00.000Z' }))).toThrow(/stale/);
		expect(() => validateLive(liveSnapshot({ capturedAt: 'not-a-date' }))).toThrow(/capturedAt/);
	});

	it.each([['workersDev', true], ['previewUrls', true]] as const)('rejects unintended %s exposure', (field, value) => {
		expect(() => validateLive(liveSnapshot({ [field]: value }))).toThrow(/exposure/);
	});

	it('accepts exact schedules only in the matching normal or paused mode', () => {
		const paused = createCronConfiguration(config(), baseline, true);
		expect(paused.triggers.crons).toEqual([]);
		expect(() => validateLive(liveSnapshot())).not.toThrow();
		expect(() => validateLive(liveSnapshot({ crons: [] }), true)).not.toThrow();
		expect(() => validateLive(liveSnapshot({ crons: [] }))).toThrow(/Cron schedules/);
		expect(() => validateLive(liveSnapshot(), true)).toThrow(/not fully paused/);
	});

	it.each([
		['normal', ['0 13 * * *', '*/5 * * * *'], false],
		['normal', [...baseline.crons, '15 3 * * *'], false],
		['paused', ['*/5 * * * *'], true],
		['paused', ['unexpected'], true],
	] as const)('rejects partial or unexpected schedules in %s mode', (_mode, crons, paused) => {
		expect(() => validateLive(liveSnapshot({ crons }), paused)).toThrow(/Cron schedules|not fully paused/);
	});

	it('rejects malformed schedule values in both modes', () => {
		expect(() => validateLive(liveSnapshot({ crons: '*/5 * * * *' }))).toThrow(/Cron schedules/);
		expect(() => validateLive(liveSnapshot({ crons: null }), true)).toThrow(/not fully paused/);
	});

	it('rejects unexpected variables or live binding drift', () => {
		expect(() => validateGeneratedConfiguration({ ...config(), vars: { ...baseline.requiredVars, UNREVIEWED: 'true' } }, baseline))
			.toThrow(/variables differ/);
		expect(() => validateLive(liveSnapshot({ r2: [{ binding: 'IMAGE_ASSETS', bucket_name: 'wrong' }] })))
			.toThrow(/R2 bindings/);
	});

	it('accepts only a complete disabled model-budget configuration', () => {
		expect(validateReviewedModelBudgetVariables({ ...disabledVars, ...budgetVars }))
			.toMatchObject({ mode: 'configured-disabled' });
		for (const [name, value] of [
			['MODEL_BUDGET_ADMISSION_ENABLED', 'true'],
			['MODEL_NORMALIZE_MAX_COST_MICRO_USD', undefined],
			['MODEL_CANDIDATES_MAX_COST_MICRO_USD', '12.5'],
			['MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD', '9007199254740992'],
			['MODEL_ITEM_BUDGET_MICRO_USD', '50000'],
		] as const) {
			const vars = { ...disabledVars, ...budgetVars, [name]: value };
			expect(() => validateReviewedModelBudgetVariables(vars)).toThrow(/model-budget|MODEL_/);
		}
	});

	it('rejects missing, wrong, or unexpectedly enabled values against the proposed exact baseline', () => {
		const targetBaseline = { ...structuredClone(baseline),
			requiredVars: { ...baseline.requiredVars, ...budgetVars } };
		const targetConfig = { ...config(), vars: targetBaseline.requiredVars };
		expect(() => validateGeneratedConfiguration(targetConfig, targetBaseline)).not.toThrow();
		for (const [name, value] of [
			['MODEL_BUDGET_ADMISSION_ENABLED', 'true'],
			['MODEL_NORMALIZE_MAX_COST_MICRO_USD', undefined],
			['MODEL_CANDIDATES_MAX_COST_MICRO_USD', '50001'],
			['MODEL_DAILY_BUDGET_MICRO_USD', 'not-a-number'],
		] as const) {
			const vars = { ...targetBaseline.requiredVars, [name]: value };
			expect(() => validateGeneratedConfiguration({ ...targetConfig, vars }, targetBaseline))
				.toThrow(/variables differ|model-budget|MODEL_/);
		}
	});

	it('validates the exact old-to-new budget baseline without weakening unrelated fields', () => {
		const { EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED: _externalGate, ...previousRequiredVars } = baseline.requiredVars;
		const previous = { ...structuredClone(baseline),
			requiredVars: { ...previousRequiredVars, MODEL_DAILY_BUDGET_MICRO_USD: '1000000' } };
		const next = { ...structuredClone(baseline), requiredVars: {
			...previous.requiredVars, ...budgetVars, EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED: 'false',
		} };
		const contract = structuredClone(transitionContract);
		expect(validateBaselineTransition(previous, next, contract)).toMatchObject({
			changedVariables: [...Object.keys(budgetVars), 'EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED'].sort(),
		});
		expect(() => validateBaselineTransition(previous, { ...next, routes: [] }, contract)).toThrow(/outside requiredVars/);
		expect(() => validateBaselineTransition(previous, next, { ...contract, allowedVariableChanges: {
			...contract.allowedVariableChanges, MODEL_BUDGET_ADMISSION_ENABLED: { from: null, to: 'true' },
		} })).toThrow(/from\/to/);
	});

	it('rejects non-Cron configuration drift in paused mode', () => {
		expect(() => validateLive(liveSnapshot({ crons: [], routes: [] }), true)).toThrow(/custom-domain routes/);
		expect(() => validateLive(liveSnapshot({ crons: [], vars: { ...disabledVars, IMAGE_GENERATION_ENABLED: 'true' } }), true))
			.toThrow(/variables differ/);
	});

	it('requires complete uploaded bindings and deployed module inventory before activation', async () => {
		const fixture = await packageFixture();
		const bindings = [
			...Object.entries(baseline.requiredVars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
			{ name: 'SECRET_A', type: 'secret_text' }, { name: 'DB', database_id: 'db-1', type: 'd1' },
			{ name: 'IMAGES', bucket_name: 'images', type: 'r2_bucket' }, { name: 'ASSETS', type: 'assets' },
		];
		expect(validateUploadedVersion({ id: 'version-1', resources: { script: { handlers: ['fetch', 'scheduled'] },
			script_runtime: { compatibility_date: '2026-09-10', compatibility_flags: ['nodejs_compat'] }, bindings } }, baseline))
			.toMatchObject({ versionId: 'version-1' });
		await expect(validateDeployedModuleInventory(fixture.source, { modules: ['entry.mjs'] })).rejects.toThrow(/dependency\.mjs/);
	});

	it('rejects a rollback version unless every generation gate is disabled', () => {
		const bindings = Object.entries({ ...baseline.requiredVars, IMAGE_GENERATION_ENABLED: 'true' })
			.map(([name, text]) => ({ name, text, type: 'plain_text' }));
		expect(() => validateDisabledVersionSnapshot({ resources: { bindings } }, baseline)).toThrow(/IMAGE_GENERATION_ENABLED/);
	});
});
