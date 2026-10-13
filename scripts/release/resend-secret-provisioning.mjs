import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { ReleaseSafetyError, validateUploadedVersion } from './release-safety.mjs';

export const RESEND_SECRET_NAMES = Object.freeze([
	'EDITORIAL_NOTIFICATION_TO_EMAIL',
	'RESEND_API_KEY',
	'RESEND_WEBHOOK_SIGNING_SECRET',
	'REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN',
]);

const VERSION_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

function sameNames(left, right) {
	return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function validateProvisioningSecrets(secrets) {
	if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
		throw new ReleaseSafetyError('Protected secret input must be an object.');
	}
	const names = Object.keys(secrets);
	if (!sameNames(names, RESEND_SECRET_NAMES)) {
		throw new ReleaseSafetyError('Protected secret input does not contain the exact reviewed secret set.');
	}
	for (const name of RESEND_SECRET_NAMES) {
		if (typeof secrets[name] !== 'string' || secrets[name].length === 0) {
			throw new ReleaseSafetyError(`Protected secret ${name} is missing or empty.`);
		}
	}
	if (secrets.REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN.length < 32) {
		throw new ReleaseSafetyError('The review-notification bearer token must contain at least 32 characters.');
	}
	return true;
}

export function redactSecretText(value, secrets) {
	let result = String(value ?? '');
	for (const secret of Object.values(secrets ?? {}).filter((item) => typeof item === 'string' && item)) {
		result = result.split(secret).join('[REDACTED]');
	}
	return result;
}

export function inactiveSecretBulkArgs({ workerName, tag, message }) {
	return ['versions', 'secret', 'bulk', '--config', 'dist/server/wrangler.json', '--name', workerName,
		'--tag', tag, '--message', message];
}

export function inactiveVersionInspectArgs({ workerName, versionId }) {
	return ['versions', 'view', versionId, '--name', workerName, '--json'];
}

export function defaultWranglerExecutor(args, input) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), ...args], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.once('error', reject);
		child.once('exit', (code) => resolvePromise({ code, stdout, stderr }));
		child.stdin.end(input ?? '');
	});
}

function parseJsonOutput(output) {
	const trimmed = output.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf('{');
		const end = trimmed.lastIndexOf('}');
		if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
		throw new ReleaseSafetyError('Wrangler did not return a parseable inactive-version inspection.');
	}
}

export async function createAndInspectInactiveResendSecretVersion({
	secrets, baseline, tag, message, execute = defaultWranglerExecutor,
}) {
	validateProvisioningSecrets(secrets);
	const bulkArgs = inactiveSecretBulkArgs({ workerName: baseline.workerName, tag, message });
	const submitted = await execute(bulkArgs, JSON.stringify(secrets));
	if (submitted.code !== 0) {
		throw new ReleaseSafetyError('Inactive secret-version creation failed. Do not retry automatically.', [
			redactSecretText(submitted.stderr || submitted.stdout || `Wrangler exited with ${submitted.code}`, secrets),
		]);
	}
	const versionId = `${submitted.stdout}\n${submitted.stderr}`.match(VERSION_ID)?.[0];
	if (!versionId) {
		throw new ReleaseSafetyError(
			'Wrangler may have created an inactive version, but its identity was not confirmed. Investigate before retrying.',
			[redactSecretText(submitted.stderr || submitted.stdout, secrets)],
		);
	}
	const inspected = await execute(inactiveVersionInspectArgs({ workerName: baseline.workerName, versionId }), '');
	if (inspected.code !== 0) {
		throw new ReleaseSafetyError(
			`Inactive version ${versionId} was created but inspection failed. Do not activate or repeat provisioning.`,
			[redactSecretText(inspected.stderr || inspected.stdout, secrets)],
		);
	}
	const snapshot = parseJsonOutput(inspected.stdout);
	const validation = validateUploadedVersion(snapshot, baseline);
	if (validation.versionId !== versionId) {
		throw new ReleaseSafetyError('Inspected inactive version identity does not match the created version.');
	}
	return {
		versionId,
		status: 'INSPECTED_INACTIVE',
		secretNames: [...baseline.requiredSecrets].sort(),
		capabilityGates: Object.fromEntries(Object.entries(baseline.requiredVars)
			.filter(([name]) => name.endsWith('_ENABLED') && name !== 'AUTOMATION_ENABLED')),
		activationPerformed: false,
	};
}
