import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createCronConfiguration,
	validateDeployedModuleInventory,
	validateActivationTarget,
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

const budgetVars = {
	MODEL_BUDGET_ADMISSION_ENABLED: 'false',
	MODEL_NORMALIZE_MAX_COST_MICRO_USD: '50000',
	MODEL_CANDIDATES_MAX_COST_MICRO_USD: '50000',
	MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD: '60000',
	MODEL_ITEM_BUDGET_MICRO_USD: '170000',
	MODEL_BATCH_BUDGET_MICRO_USD: '510000',
	MODEL_DAILY_BUDGET_MICRO_USD: '510000',
};

const baseline = {
	accountId: 'account-1', workerName: 'worker-1', main: 'entry.mjs', workersDev: false, previewUrls: false,
	compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'],
	routes: [{ pattern: 'example.com', custom_domain: true }], crons: ['0 13 * * *', '0 21 * * *', '*/5 * * * *'],
	assets: { binding: 'ASSETS', directory: '../client' },
	d1: [{ binding: 'DB', database_name: 'production', database_id: 'db-1' }],
	r2: [{ binding: 'IMAGES', bucket_name: 'images' }], requiredSecrets: ['SECRET_A'],
	requiredVars: { MODEL_GENERATION_ENABLED: 'false', ...budgetVars,
		EDITORIAL_WORKFLOW_GENERATION_ENABLED: 'false',
		EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED: 'false', EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED: 'false',
		EDITORIAL_AUTOMATED_PUBLICATION_ENABLED: 'false',
		IMAGE_GENERATION_ENABLED: 'false', EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY: '',
		IMAGE_ATTEMPT_BUDGET_MICRO_USD: '50000', IMAGE_BATCH_BUDGET_MICRO_USD: '150000',
		IMAGE_DAILY_BUDGET_MICRO_USD: '150000' },
};

const disabledVars = { MODEL_GENERATION_ENABLED: 'false', ...budgetVars,
	EDITORIAL_WORKFLOW_GENERATION_ENABLED: 'false',
	EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED: 'false', EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED: 'false',
	EDITORIAL_AUTOMATED_PUBLICATION_ENABLED: 'false',
	IMAGE_GENERATION_ENABLED: 'false', EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY: '',
	IMAGE_ATTEMPT_BUDGET_MICRO_USD: '50000', IMAGE_BATCH_BUDGET_MICRO_USD: '150000',
	IMAGE_DAILY_BUDGET_MICRO_USD: '150000' };

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
		secrets: { required: baseline.requiredSecrets }, vars: baseline.requiredVars,
		rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] };
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
			read('release/production-baseline.pre-resend.json'),
			read('release/model-budget-baseline-transition.json'),
		)).toMatchObject({ name: 'phase-4e-governed-editorial-automation-disabled' });
	});

	it('accepts genuinely absent legacy automation gates only in an explicitly reviewed previous state', () => {
		const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
		const previous = read('release/production-baseline.pre-model-budget.json');
		const target = read('release/production-baseline.pre-resend.json');
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
		const target = read('release/production-baseline.pre-resend.json');
		const contract = read('release/model-budget-baseline-transition.json');
		delete contract.allowedVariableChanges.EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED;
		expect(() => validateBaselineTransition(previous, target, contract))
			.toThrow(/actual variable changes differ/);
	});

	it('validates only the two reviewed disabled Resend routing variables', () => {
		const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
		const previous = read('release/production-baseline.pre-resend.json');
		const target = read('release/production-baseline.pre-resend-secrets.json');
		const contract = read('release/resend-email-baseline-transition.json');
		expect(validateBaselineTransition(previous, target, contract)).toMatchObject({
			name: 'phase-4h-resend-email-disabled',
			changedVariables: ['EDITORIAL_NOTIFICATION_FROM_EMAIL', 'REVIEW_NOTIFICATION_EXTERNAL_URL'],
		});
		expect(target.requiredSecrets).toEqual(previous.requiredSecrets);
		for (const secret of ['RESEND_API_KEY', 'RESEND_WEBHOOK_SIGNING_SECRET',
			'EDITORIAL_NOTIFICATION_TO_EMAIL', 'REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN']) {
			expect(target.requiredSecrets).not.toContain(secret);
		}
		const previousSnapshot = {
			capturedAt: '2026-10-12T21:55:00.000Z', accountId: previous.accountId,
			workerName: previous.workerName, d1: previous.d1, r2: previous.r2, assets: previous.assets,
			workersDev: false, previewUrls: false, routes: previous.routes, crons: previous.crons,
			secretNames: previous.requiredSecrets, vars: previous.requiredVars,
		};
		expect(() => validateLiveSnapshot(previousSnapshot, previous, {
			now: snapshotNow, liveState: 'previous',
			transition: validateBaselineTransition(previous, target, contract),
		})).not.toThrow();
		expect(() => validateBaselineTransition(previous, target, {
			...contract, allowedVariableChanges: {
				...contract.allowedVariableChanges, UNREVIEWED: { from: null, to: 'false' },
			},
		})).toThrow(/actual variable changes differ/);
	});

	it('allows exactly the reviewed additive Resend secret bindings', () => {
		const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
		const previous = read('release/production-baseline.pre-resend-secrets.json');
		const target = read('release/production-baseline.pre-notification-acceptance-test.json');
		const contract = read('release/resend-secret-baseline-transition.json');
		const expected = ['EDITORIAL_NOTIFICATION_TO_EMAIL', 'RESEND_API_KEY',
			'RESEND_WEBHOOK_SIGNING_SECRET', 'REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN'];
		expect(validateBaselineTransition(previous, target, contract)).toMatchObject({
			name: 'phase-4i-resend-secrets-disabled', changedVariables: [], changedSecrets: expected,
		});
		for (const removed of expected) {
			const missing = structuredClone(target);
			missing.requiredSecrets = missing.requiredSecrets.filter((name: string) => name !== removed);
			expect(() => validateBaselineTransition(previous, missing, contract)).toThrow(/secret binding changes/);
		}
		const extra = structuredClone(target);
		extra.requiredSecrets.push('UNREVIEWED_SECRET');
		expect(() => validateBaselineTransition(previous, extra, contract)).toThrow(/secret binding changes/);
		const renamed = structuredClone(target);
		renamed.requiredSecrets = renamed.requiredSecrets
			.filter((name: string) => name !== 'RESEND_API_KEY').concat('RESEND_API_TOKEN');
		expect(() => validateBaselineTransition(previous, renamed, contract)).toThrow(/secret binding changes/);
		const removalContract = structuredClone(contract);
		removalContract.allowedSecretChanges.CLOUDFLARE_AI_API_TOKEN = { from: 'present', to: null };
		const removedExisting = structuredClone(target);
		removedExisting.requiredSecrets = removedExisting.requiredSecrets
			.filter((name: string) => name !== 'CLOUDFLARE_AI_API_TOKEN');
		expect(() => validateBaselineTransition(previous, removedExisting, removalContract))
			.toThrow(/not an additive/);
	});

	it('introduces only a disabled, blank notification acceptance-test authorization', () => {
		const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
		const previous = read('release/production-baseline.pre-notification-acceptance-test.json');
		const target = read('release/production-baseline.json');
		const contract = read('release/notification-acceptance-test-baseline-transition.json');
		expect(validateBaselineTransition(previous, target, contract)).toMatchObject({
			name: 'phase-4i6-notification-acceptance-test-disabled',
			changedVariables: [
				'EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID',
				'EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED',
			],
			changedSecrets: [],
		});
		const targetConfig = { ...config(), account_id: target.accountId, name: target.workerName,
			topLevelName: target.workerName, routes: target.routes, triggers: { crons: target.crons },
			assets: target.assets, d1_databases: target.d1, r2_buckets: target.r2,
			vars: target.requiredVars, secrets: { required: target.requiredSecrets } };
		expect(() => validateGeneratedConfiguration(targetConfig, target)).not.toThrow();
		for (const vars of [
			{ ...target.requiredVars, EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED: 'true' },
			{ ...target.requiredVars, EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID: 'unexpected' },
		]) expect(() => validateGeneratedConfiguration({ ...targetConfig, vars }, target))
			.toThrow(/acceptance-test|variables differ/);
		const unauthorized = structuredClone(contract);
		delete unauthorized.allowedVariableChanges.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED;
		expect(() => validateBaselineTransition(previous, target, unauthorized))
			.toThrow(/actual variable changes differ/);
	});

	it('requires target generated and live configurations to contain all seven secret names', () => {
		const target = { ...structuredClone(baseline), requiredSecrets: [
			'SECRET_A', 'SECRET_B', 'SECRET_C', 'SECRET_D', 'SECRET_E', 'SECRET_F', 'SECRET_G',
		] };
		const targetConfig = { ...config(), secrets: { required: target.requiredSecrets }, vars: target.requiredVars };
		expect(() => validateGeneratedConfiguration(targetConfig, target)).not.toThrow();
		expect(() => validateGeneratedConfiguration({ ...targetConfig,
			secrets: { required: target.requiredSecrets.slice(0, -1) } }, target)).toThrow(/required secret names/);
		const snapshot = { ...liveSnapshot(), vars: target.requiredVars, secretNames: target.requiredSecrets };
		expect(() => validateLiveSnapshot(snapshot, target, { now: snapshotNow })).not.toThrow();
		expect(() => validateLiveSnapshot({ ...snapshot, secretNames: target.requiredSecrets.slice(0, -1) }, target,
			{ now: snapshotNow })).toThrow(/secret binding names/);
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
		const previousRequiredVars: Record<string, string> = { ...baseline.requiredVars };
		delete previousRequiredVars.EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED;
		for (const name of Object.keys(budgetVars)) delete previousRequiredVars[name];
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

	it('rejects activation when the requested and inspected version identities differ', () => {
		expect(validateActivationTarget('version-1', 'version-1')).toBe(true);
		expect(() => validateActivationTarget('version-1', 'version-2')).toThrow(/does not match/);
	});

	it('rejects a rollback version unless every generation gate is disabled', () => {
		const bindings = Object.entries({ ...baseline.requiredVars, IMAGE_GENERATION_ENABLED: 'true' })
			.map(([name, text]) => ({ name, text, type: 'plain_text' }));
		expect(() => validateDisabledVersionSnapshot({ resources: { bindings } }, baseline)).toThrow(/IMAGE_GENERATION_ENABLED/);
	});
});
