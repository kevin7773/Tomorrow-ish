import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	createCronConfiguration,
	readJson,
	validateBaselineTransition,
	validateGeneratedConfiguration,
} from './release-safety.mjs';

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

function fingerprint(value) {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

const serverDirectory = resolve(option('--server-dir', 'dist/server'));
const privateDirectory = resolve(option('--private-dir', '.release/private/notification-acceptance'));
const canonicalBaseline = await readJson(resolve('release/production-baseline.json'));
const canonicalConfig = await readJson(resolve(serverDirectory, 'wrangler.json'));
const enableContract = await readJson(resolve(option('--enable-contract',
	'release/notification-acceptance-test-enable-transition.json')));
const disableContract = await readJson(resolve(option('--disable-contract',
	'release/notification-acceptance-test-disable-transition.json')));
const generatedPaths = [
	resolve(privateDirectory, 'production-baseline.acceptance-enabled.json'),
	resolve(serverDirectory, 'wrangler.acceptance.json'),
	resolve(serverDirectory, 'wrangler.acceptance.pause.json'),
	resolve(serverDirectory, 'wrangler.acceptance.restore.json'),
	resolve(privateDirectory, 'preparation-redacted.json'),
];

let authorizationId;
try {
	const input = JSON.parse(readFileSync(0, 'utf8'));
	authorizationId = input?.authorizationId;
	if (typeof authorizationId !== 'string' || !/^[a-z0-9:_-]{16,200}$/.test(authorizationId)) {
		throw new Error('invalid protected authorization');
	}
	const reviewedFingerprint = enableContract.allowedVariableChanges
		.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID.toSha256;
	if (fingerprint(authorizationId) !== reviewedFingerprint) throw new Error('fingerprint mismatch');
	if (disableContract.allowedVariableChanges
		.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID.fromSha256 !== reviewedFingerprint) {
		throw new Error('reversal contract mismatch');
	}

	const targetBaseline = structuredClone(canonicalBaseline);
	targetBaseline.requiredVars.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED = 'true';
	targetBaseline.requiredVars.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID = authorizationId;
	const enableTransition = validateBaselineTransition(canonicalBaseline, targetBaseline, enableContract);
	validateBaselineTransition(targetBaseline, canonicalBaseline, disableContract);

	const targetConfig = structuredClone(canonicalConfig);
	targetConfig.vars = structuredClone(targetBaseline.requiredVars);
	const acceptancePolicy = enableTransition.notificationAcceptanceTest.target;
	validateGeneratedConfiguration(targetConfig, targetBaseline,
		{ notificationAcceptanceTest: acceptancePolicy });
	const pausedConfig = createCronConfiguration(targetConfig, targetBaseline, true,
		{ notificationAcceptanceTest: acceptancePolicy });
	const restoredConfig = createCronConfiguration(targetConfig, targetBaseline, false,
		{ notificationAcceptanceTest: acceptancePolicy });

	await mkdir(privateDirectory, { recursive: true });
	await Promise.all([
		writeFile(resolve(privateDirectory, 'production-baseline.acceptance-enabled.json'),
			`${JSON.stringify(targetBaseline, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
		writeFile(resolve(serverDirectory, 'wrangler.acceptance.json'),
			`${JSON.stringify(targetConfig, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
		writeFile(resolve(serverDirectory, 'wrangler.acceptance.pause.json'),
			`${JSON.stringify(pausedConfig, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
		writeFile(resolve(serverDirectory, 'wrangler.acceptance.restore.json'),
			`${JSON.stringify(restoredConfig, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
		writeFile(resolve(privateDirectory, 'preparation-redacted.json'), `${JSON.stringify({
			ok: true,
			authorizationIdSha256: reviewedFingerprint,
			authorizationIdLength: authorizationId.length,
			routineCapabilityGates: 'all-disabled',
			enableTransition: enableTransition.name,
			disableTransition: disableContract.name,
		}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
	]);
	process.stdout.write(`${JSON.stringify({ ok: true, authorizationIdSha256: reviewedFingerprint,
		privateDirectory, serverDirectory })}\n`);
} catch {
	await Promise.all(generatedPaths.map((path) => rm(path, { force: true }).catch(() => {})));
	process.stderr.write('Acceptance-transition preparation failed closed. Protected input was not disclosed.\n');
	process.exitCode = 1;
} finally {
	authorizationId = undefined;
}
