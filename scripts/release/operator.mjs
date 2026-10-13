import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertOnlyCronDifference, readJson, validateDeployedModuleInventory, validateDisabledVersionSnapshot, validateDryRunPackage,
	validateBaselineTransition, validateGeneratedConfiguration, validateLiveSnapshot, validateUploadedVersion } from './release-safety.mjs';

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
const baseline = await readJson(resolve('release/production-baseline.json'));
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
const previousBaseline = transitionFromPath ? await readJson(resolve(transitionFromPath)) : null;
let transition = null;
if (previousBaseline) {
	transition = validateBaselineTransition(previousBaseline, baseline, await readJson(resolve(transitionContractPath)));
}
const config = await readJson(resolve('dist/server/wrangler.json'));
validateGeneratedConfiguration(config, baseline);
await validateDryRunPackage(resolve('dist/server'), resolve('.release/wrangler-dry-run'), config);
if (process.env.CLOUDFLARE_ACCOUNT_ID !== baseline.accountId) {
	throw new Error(`CLOUDFLARE_ACCOUNT_ID must explicitly equal ${baseline.accountId}`);
}
const liveSnapshot = required('--live-snapshot');
const expectPaused = ['upload', 'inspect', 'activate', 'cron-restore'].includes(action)
	|| (action === 'rollback' && process.argv.includes('--cron-paused'));
validateLiveSnapshot(await readJson(resolve(liveSnapshot)), liveState === 'previous' ? previousBaseline : baseline,
	{ paused: expectPaused, liveState, transition });

if (action === 'upload') {
	await run(['versions', 'upload', '--config', 'dist/server/wrangler.json', '--strict',
		'--tag', required('--tag'), '--message', required('--message')]);
} else if (action === 'inspect') {
	await run(['versions', 'view', required('--version'), '--name', baseline.workerName, '--json']);
} else if (action === 'activate') {
	const versionId = required('--version');
	const inspected = validateUploadedVersion(await readJson(resolve(required('--version-snapshot'))), baseline);
	if (inspected.versionId !== versionId) throw new Error('Inspected version does not match the requested activation version.');
	await validateDeployedModuleInventory(resolve('dist/server'), await readJson(resolve(required('--module-inventory'))));
	await run(['versions', 'deploy', `${versionId}@100%`, '--name', baseline.workerName,
		'--message', required('--message'), '--yes']);
} else if (action === 'cron-pause') {
	const cronConfig = await readJson(resolve('dist/server/wrangler.pause.json'));
	validateGeneratedConfiguration(cronConfig, baseline, { paused: true });
	assertOnlyCronDifference(config, cronConfig);
	await run(['triggers', 'deploy', '--config', 'dist/server/wrangler.pause.json']);
} else if (action === 'cron-restore') {
	const cronConfig = await readJson(resolve('dist/server/wrangler.restore.json'));
	validateGeneratedConfiguration(cronConfig, baseline);
	assertOnlyCronDifference(config, cronConfig);
	await run(['triggers', 'deploy', '--config', 'dist/server/wrangler.restore.json']);
} else {
	const versionSnapshot = await readJson(resolve(required('--version-snapshot')));
	const rollbackBaseline = process.argv.includes('--rollback-to-previous')
		? previousBaseline
		: baseline;
	if (!rollbackBaseline) throw new Error('--rollback-to-previous requires an exact reviewed baseline transition.');
	validateUploadedVersion(versionSnapshot, rollbackBaseline);
	validateDisabledVersionSnapshot(versionSnapshot, rollbackBaseline);
	await run(['versions', 'deploy', `${required('--version')}@100%`, '--name', baseline.workerName,
		'--message', required('--message'), '--yes']);
}
