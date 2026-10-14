import { execFile, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertOnlyCronDifference, readJson, validateDeployedModuleInventory, validateDisabledVersionSnapshot, validateDryRunPackage,
	validateActivationTarget, validateBaselineTransition, validateGeneratedConfiguration, validateLiveSnapshot,
	validateUploadedVersion } from './release-safety.mjs';

function option(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : null;
}

function required(name) {
	const value = option(name);
	if (!value) throw new Error(`Missing required option ${name}`);
	return value;
}

function run(args) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), ...args], { stdio: 'inherit' });
		child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`wrangler exited with ${code}`)));
	});
}

const execute = promisify(execFile);

const action = process.argv[2];
const allowed = new Set(['upload', 'inspect', 'activate', 'cron-pause', 'cron-restore', 'rollback']);
if (!allowed.has(action)) throw new Error(`Usage: operator.mjs <${[...allowed].join('|')}> [options]`);
if (!process.argv.includes('--execute')) throw new Error('Refusing production command without --execute. Review the documented preflight first.');
const expectedCommit = required('--commit');
const head = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
const remote = (await execute('git', ['rev-parse', 'origin/main'])).stdout.trim();
const dirty = (await execute('git', ['status', '--porcelain'])).stdout.trim();
if (head !== expectedCommit || remote !== expectedCommit || dirty) {
	throw new Error('Operator action requires clean local and remote main at the approved commit.');
}
const canonicalBaselinePath = resolve('release/production-baseline.json');
const canonicalConfigPath = resolve('dist/server/wrangler.json');
const baselinePath = resolve(option('--baseline') ?? canonicalBaselinePath);
const configPath = resolve(option('--config') ?? canonicalConfigPath);
const baseline = await readJson(baselinePath);
const transitionFromPath = option('--transition-from-baseline');
const transitionContractPath = option('--transition-contract');
const liveState = option('--live-state') ?? 'target';
if ((transitionFromPath === null) !== (transitionContractPath === null)) {
	throw new Error('--transition-from-baseline and --transition-contract must be supplied together.');
}
if (!['previous', 'target'].includes(liveState)) throw new Error('--live-state must be previous or target.');
if (liveState === 'previous' && !transitionFromPath) {
	throw new Error('--live-state previous requires an exact reviewed baseline transition.');
}
if ((baselinePath !== canonicalBaselinePath || configPath !== canonicalConfigPath) && !transitionFromPath) {
	throw new Error('A noncanonical baseline or configuration requires an exact reviewed baseline transition.');
}
const previousBaseline = transitionFromPath ? await readJson(resolve(transitionFromPath)) : null;
let transition = null;
if (previousBaseline) {
	transition = validateBaselineTransition(previousBaseline, baseline, await readJson(resolve(transitionContractPath)));
}
const targetAcceptance = transition?.notificationAcceptanceTest?.target;
const liveAcceptance = transition?.notificationAcceptanceTest?.[liveState];
const config = await readJson(configPath);
const cronConfigPrefix = configPath.endsWith('.json') ? configPath.slice(0, -'.json'.length) : configPath;
validateGeneratedConfiguration(config, baseline, { notificationAcceptanceTest: targetAcceptance });
await validateDryRunPackage(dirname(configPath), resolve('.release/wrangler-dry-run'), config);
if (process.env.CLOUDFLARE_ACCOUNT_ID !== baseline.accountId) {
	throw new Error(`CLOUDFLARE_ACCOUNT_ID must explicitly equal ${baseline.accountId}`);
}
const liveSnapshot = required('--live-snapshot');
const expectPaused = ['upload', 'inspect', 'activate', 'cron-restore'].includes(action)
	|| (action === 'rollback' && process.argv.includes('--cron-paused'));
validateLiveSnapshot(await readJson(resolve(liveSnapshot)), liveState === 'previous' ? previousBaseline : baseline,
	{ paused: expectPaused, liveState, transition, notificationAcceptanceTest: liveAcceptance });

if (action === 'upload') {
	await run(['versions', 'upload', '--config', configPath, '--strict',
		'--tag', required('--tag'), '--message', required('--message')]);
} else if (action === 'inspect') {
	await run(['versions', 'view', required('--version'), '--name', baseline.workerName, '--json']);
} else if (action === 'activate') {
	const versionId = required('--version');
	const inspected = validateUploadedVersion(await readJson(resolve(required('--version-snapshot'))), baseline,
		{ notificationAcceptanceTest: targetAcceptance });
	validateActivationTarget(versionId, inspected.versionId);
	await validateDeployedModuleInventory(dirname(configPath), await readJson(resolve(required('--module-inventory'))));
	await run(['versions', 'deploy', `${versionId}@100%`, '--name', baseline.workerName,
		'--message', required('--message'), '--yes']);
} else if (action === 'cron-pause') {
	const cronConfigPath = `${cronConfigPrefix}.pause.json`;
	const cronConfig = await readJson(cronConfigPath);
	validateGeneratedConfiguration(cronConfig, baseline,
		{ paused: true, notificationAcceptanceTest: targetAcceptance });
	assertOnlyCronDifference(config, cronConfig);
	await run(['triggers', 'deploy', '--config', cronConfigPath]);
} else if (action === 'cron-restore') {
	const cronConfigPath = `${cronConfigPrefix}.restore.json`;
	const cronConfig = await readJson(cronConfigPath);
	validateGeneratedConfiguration(cronConfig, baseline, { notificationAcceptanceTest: targetAcceptance });
	assertOnlyCronDifference(config, cronConfig);
	await run(['triggers', 'deploy', '--config', cronConfigPath]);
} else {
	const versionSnapshot = await readJson(resolve(required('--version-snapshot')));
	const rollbackBaseline = process.argv.includes('--rollback-to-previous')
		? previousBaseline
		: baseline;
	if (!rollbackBaseline) throw new Error('--rollback-to-previous requires an exact reviewed baseline transition.');
	validateUploadedVersion(versionSnapshot, rollbackBaseline,
		{ notificationAcceptanceTest: transition?.notificationAcceptanceTest?.target });
	validateDisabledVersionSnapshot(versionSnapshot, rollbackBaseline);
	await run(['versions', 'deploy', `${required('--version')}@100%`, '--name', baseline.workerName,
		'--message', required('--message'), '--yes']);
}
