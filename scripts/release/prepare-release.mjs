import { rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { readJson, validateDryRunPackage, validateGeneratedConfiguration } from './release-safety.mjs';

function run(command, args) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: 'inherit' });
		child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
	});
}

const execute = promisify(execFile);
function option(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : null;
}

const expectedCommit = option('--commit');
const localCheckpoint = process.argv.includes('--local-checkpoint');
if (!expectedCommit && !localCheckpoint) {
	throw new Error('A production release requires --commit <approved-sha>. Use --local-checkpoint only for a non-uploadable local validation.');
}
const head = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
const remote = (await execute('git', ['rev-parse', 'origin/main'])).stdout.trim();
const dirty = (await execute('git', ['status', '--porcelain'])).stdout.trim();
if (!localCheckpoint && (head !== expectedCommit || remote !== expectedCommit || dirty)) {
	throw new Error('Release source is not a clean local/remote main checkout at the approved commit.');
}

const output = resolve('.release/wrangler-dry-run');
await run(process.execPath, [resolve('node_modules/astro/bin/astro.mjs'), 'build']);
const config = await readJson(resolve('dist/server/wrangler.json'));
const baseline = await readJson(resolve('release/production-baseline.json'));
validateGeneratedConfiguration(config, baseline);
await rm(output, { recursive: true, force: true });
await run(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'versions', 'upload',
	'--config', 'dist/server/wrangler.json', '--strict', '--dry-run', '--outdir', output]);
const report = await validateDryRunPackage(resolve('dist/server'), output, config);
console.log(JSON.stringify({ ok: true, releaseEligible: !localCheckpoint, sourceCommit: head,
	config: 'dist/server/wrangler.json', output, ...report }, null, 2));
