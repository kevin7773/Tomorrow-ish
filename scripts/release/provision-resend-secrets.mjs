import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createAndInspectInactiveResendSecretVersion } from './resend-secret-provisioning.mjs';
import { readProtectedJsonInput } from './protected-stdin.mjs';
import { readJson, validateBaselineTransition, validateDryRunPackage, validateGeneratedConfiguration,
	validateLiveSnapshot } from './release-safety.mjs';

function option(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : null;
}

function required(name) {
	const value = option(name);
	if (!value) throw new Error(`Missing required option ${name}`);
	return value;
}

if (!process.argv.includes('--execute')) {
	throw new Error('Refusing secret provisioning without --execute. This command only creates and inspects an inactive version.');
}

const execute = promisify(execFile);
const expectedCommit = required('--commit');
const head = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
const remote = (await execute('git', ['rev-parse', 'origin/main'])).stdout.trim();
const dirty = (await execute('git', ['status', '--porcelain'])).stdout.trim();
if (head !== expectedCommit || remote !== expectedCommit || dirty) {
	throw new Error('Provisioning requires clean local and remote main at the separately approved commit.');
}

const baseline = await readJson(resolve('release/production-baseline.json'));
const previous = await readJson(resolve('release/production-baseline.pre-resend-secrets.json'));
const transition = validateBaselineTransition(previous, baseline,
	await readJson(resolve('release/resend-secret-baseline-transition.json')));
if (process.env.CLOUDFLARE_ACCOUNT_ID !== baseline.accountId) {
	throw new Error(`CLOUDFLARE_ACCOUNT_ID must explicitly equal ${baseline.accountId}`);
}
const config = await readJson(resolve('dist/server/wrangler.json'));
validateGeneratedConfiguration(config, baseline);
await validateDryRunPackage(resolve('dist/server'), resolve('.release/wrangler-dry-run'), config);
validateLiveSnapshot(await readJson(resolve(required('--live-snapshot'))), previous,
	{ liveState: 'previous', transition });

const protectedInput = readProtectedJsonInput();
const evidence = await createAndInspectInactiveResendSecretVersion({
	secrets: protectedInput,
	baseline,
	tag: required('--tag'),
	message: required('--message'),
});
const evidencePath = resolve(required('--evidence'));
await writeFile(evidencePath, `${JSON.stringify({
	...evidence,
	createdAt: new Date().toISOString(),
	sourceCommit: head,
	transition: transition.name,
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ ok: true, ...evidence, evidencePath }, null, 2));
