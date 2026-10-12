import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createCronConfiguration,
	validateDeployedModuleInventory,
	validateDisabledVersionSnapshot,
	validateDryRunPackage,
	validateGeneratedConfiguration,
	validateLiveSnapshot,
	validateUploadedVersion,
} from '../scripts/release/release-safety.mjs';

const roots: string[] = [];
afterEach(async () => {
	const { rm } = await import('node:fs/promises');
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const baseline = {
	accountId: 'account-1', workerName: 'worker-1', main: 'entry.mjs', workersDev: false, previewUrls: false,
	compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'],
	routes: [{ pattern: 'example.com', custom_domain: true }], crons: ['*/5 * * * *'],
	assets: { binding: 'ASSETS', directory: '../client' },
	d1: [{ binding: 'DB', database_name: 'production', database_id: 'db-1' }],
	r2: [{ binding: 'IMAGES', bucket_name: 'images' }], requiredSecrets: ['SECRET_A'],
	requiredVars: { MODEL_GENERATION_ENABLED: 'false', EDITORIAL_WORKFLOW_GENERATION_ENABLED: 'false',
		IMAGE_GENERATION_ENABLED: 'false', EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY: '' },
};

const disabledVars = { MODEL_GENERATION_ENABLED: 'false', EDITORIAL_WORKFLOW_GENERATION_ENABLED: 'false',
	IMAGE_GENERATION_ENABLED: 'false', EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY: '' };

function config() {
	return { account_id: 'account-1', name: 'worker-1', topLevelName: 'worker-1', main: 'entry.mjs', no_bundle: true,
		compatibility_date: '2026-09-10', compatibility_flags: ['nodejs_compat'],
		workers_dev: false, preview_urls: false, routes: baseline.routes, triggers: { crons: baseline.crons },
		assets: baseline.assets, d1_databases: baseline.d1, r2_buckets: baseline.r2,
		vars: baseline.requiredVars, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] };
}

function liveSnapshot(overrides = {}) {
	return { accountId: 'account-1', workerName: 'worker-1', d1: baseline.d1, r2: baseline.r2,
		assets: baseline.assets, workersDev: false, previewUrls: false, routes: baseline.routes,
		crons: baseline.crons, secretNames: ['SECRET_A'], vars: disabledVars, ...overrides };
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
		expect(() => validateLiveSnapshot(liveSnapshot({ accountId: 'wrong' }), baseline))
			.toThrow(/account/);
	});

	it.each([['workersDev', true], ['previewUrls', true]] as const)('rejects unintended %s exposure', (field, value) => {
		expect(() => validateLiveSnapshot(liveSnapshot({ [field]: value }), baseline)).toThrow(/exposure/);
	});

	it('detects incomplete Cron restoration and permits only a Cron-only pause', () => {
		const paused = createCronConfiguration(config(), baseline, true);
		expect(paused.triggers.crons).toEqual([]);
		expect(() => validateLiveSnapshot(liveSnapshot({ crons: [] }), baseline))
			.toThrow(/Cron schedules/);
	});

	it('rejects unexpected variables or live binding drift', () => {
		expect(() => validateGeneratedConfiguration({ ...config(), vars: { ...baseline.requiredVars, UNREVIEWED: 'true' } }, baseline))
			.toThrow(/variables differ/);
		expect(() => validateLiveSnapshot(liveSnapshot({ r2: [{ binding: 'IMAGE_ASSETS', bucket_name: 'wrong' }] }), baseline))
			.toThrow(/R2 bindings/);
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
