import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
	createAndInspectInactiveResendSecretVersion,
	inactiveSecretBulkArgs,
	RESEND_SECRET_NAMES,
	redactSecretText,
	validateProvisioningSecrets,
} from '../scripts/release/resend-secret-provisioning.mjs';

const secrets = {
	EDITORIAL_NOTIFICATION_TO_EMAIL: 'editor@example.test',
	RESEND_API_KEY: 're_test_sensitive_value',
	RESEND_WEBHOOK_SIGNING_SECRET: 'whsec_sensitive_value',
	REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN: 'a-secure-bearer-token-with-more-than-32-characters',
};

const vars = {
	MODEL_GENERATION_ENABLED: 'false',
	MODEL_BUDGET_ADMISSION_ENABLED: 'false',
	EDITORIAL_WORKFLOW_GENERATION_ENABLED: 'false',
	EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED: 'false',
	IMAGE_GENERATION_ENABLED: 'false',
	EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED: 'false',
	EDITORIAL_AUTOMATED_PUBLICATION_ENABLED: 'false',
	EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY: '',
};

const baseline = {
	workerName: 'tomorrow-ish', compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'],
	requiredSecrets: ['CLOUDFLARE_AI_API_TOKEN', 'IMAGE_WEBHOOK_SECRET', 'OPENAI_API_KEY', ...RESEND_SECRET_NAMES],
	requiredVars: vars,
	d1: [{ binding: 'DB', database_id: 'db-1' }],
	r2: [{ binding: 'IMAGE_ASSETS', bucket_name: 'images' }],
	assets: { binding: 'ASSETS' },
};

function versionSnapshot(id = '12345678-1234-4123-8123-123456789abc') {
	return { id, resources: {
		script: { handlers: ['fetch', 'scheduled'] },
		script_runtime: { compatibility_date: '2026-09-10', compatibility_flags: ['nodejs_compat'] },
		bindings: [
			...Object.entries(vars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
			...baseline.requiredSecrets.map((name) => ({ name, type: 'secret_text' })),
			{ name: 'DB', database_id: 'db-1', type: 'd1' },
			{ name: 'IMAGE_ASSETS', bucket_name: 'images', type: 'r2_bucket' },
			{ name: 'ASSETS', type: 'assets' },
		],
	} };
}

describe('protected Resend secret provisioning', () => {
	it('accepts only the exact four reviewed inputs', () => {
		expect(validateProvisioningSecrets(secrets)).toBe(true);
		expect(() => validateProvisioningSecrets({ ...secrets, EXTRA: 'no' })).toThrow(/exact reviewed secret set/);
		const { RESEND_API_KEY: _removed, ...missing } = secrets;
		expect(() => validateProvisioningSecrets(missing)).toThrow(/exact reviewed secret set/);
		expect(() => validateProvisioningSecrets({ ...missing, RESEND_API_TOKEN: secrets.RESEND_API_KEY }))
			.toThrow(/exact reviewed secret set/);
		expect(() => validateProvisioningSecrets({ ...secrets, REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN: 'short' }))
			.toThrow(/at least 32/);
	});

	it('uses only the inactive version secret-bulk command', () => {
		const args = inactiveSecretBulkArgs({ workerName: 'tomorrow-ish', tag: 'reviewed', message: 'reviewed' });
		expect(args.slice(0, 3)).toEqual(['versions', 'secret', 'bulk']);
		expect(args).not.toContain('deploy');
		expect(args).not.toContain('secret put');
	});

	it('keeps protected input out of command arguments and provides no activation path', () => {
		const wrapper = readFileSync('scripts/release/provision-resend-secrets.ps1', 'utf8');
		const cli = readFileSync('scripts/release/provision-resend-secrets.mjs', 'utf8');
		expect(wrapper).toContain('Read-Host "Enter protected value for $name" -AsSecureString');
		expect(wrapper).toContain('RedirectStandardInput = $true');
		expect(cli).not.toContain("'versions', 'deploy'");
		expect(cli).not.toContain("'secret', 'put'");
		expect(wrapper).not.toContain('Out-File');
		expect(wrapper).not.toContain('Set-Content');
	});

	it('creates and inspects one inactive version without activation', async () => {
		const calls: Array<{ args: string[]; input: string }> = [];
		const execute = vi.fn(async (args: string[], input: string) => {
			calls.push({ args, input });
			if (args[0] === 'versions' && args[1] === 'secret') {
				return { code: 0, stdout: 'Created version 12345678-1234-4123-8123-123456789abc', stderr: '' };
			}
			return { code: 0, stdout: JSON.stringify(versionSnapshot()), stderr: '' };
		});
		const result = await createAndInspectInactiveResendSecretVersion({
			secrets, baseline, tag: 'reviewed', message: 'reviewed', execute,
		});
		expect(result).toMatchObject({ status: 'INSPECTED_INACTIVE', activationPerformed: false });
		expect(calls).toHaveLength(2);
		expect(calls.some(({ args }) => args.includes('deploy'))).toBe(false);
		expect(JSON.parse(calls[0].input)).toEqual(secrets);
		expect(Object.values(result.capabilityGates)).toEqual(Array(7).fill('false'));
	});

	it('fails safely on partial or interrupted operations and redacts values', async () => {
		const execute = vi.fn(async () => ({
			code: 1,
			stdout: '',
			stderr: `provider rejected ${secrets.RESEND_API_KEY}`,
		}));
		await expect(createAndInspectInactiveResendSecretVersion({
			secrets, baseline, tag: 'reviewed', message: 'reviewed', execute,
		})).rejects.toSatisfy((error: Error) =>
			error.message.includes('[REDACTED]') && !error.message.includes(secrets.RESEND_API_KEY));
		expect(execute).toHaveBeenCalledTimes(1);

		const uncertain = vi.fn(async () => ({ code: 0, stdout: 'created but response was interrupted', stderr: '' }));
		await expect(createAndInspectInactiveResendSecretVersion({
			secrets, baseline, tag: 'reviewed', message: 'reviewed', execute: uncertain,
		})).rejects.toThrow(/may have created an inactive version/);
		expect(uncertain).toHaveBeenCalledTimes(1);
	});

	it('rejects an inspected version with the wrong identity or incomplete bindings', async () => {
		const wrongId = '87654321-4321-4321-8321-cba987654321';
		const executeWrong = vi.fn(async (args: string[]) => args[1] === 'secret'
			? { code: 0, stdout: 'Created version 12345678-1234-4123-8123-123456789abc', stderr: '' }
			: { code: 0, stdout: JSON.stringify(versionSnapshot(wrongId)), stderr: '' });
		await expect(createAndInspectInactiveResendSecretVersion({
			secrets, baseline, tag: 'reviewed', message: 'reviewed', execute: executeWrong,
		})).rejects.toThrow(/identity does not match/);

		const executePartial = vi.fn(async (args: string[]) => {
			if (args[1] === 'secret') return { code: 0, stdout: 'Created version 12345678-1234-4123-8123-123456789abc', stderr: '' };
			const snapshot = versionSnapshot();
			snapshot.resources.bindings = snapshot.resources.bindings.filter((binding) => binding.name !== 'RESEND_API_KEY');
			return { code: 0, stdout: JSON.stringify(snapshot), stderr: '' };
		});
		await expect(createAndInspectInactiveResendSecretVersion({
			secrets, baseline, tag: 'reviewed', message: 'reviewed', execute: executePartial,
		})).rejects.toThrow(/secret binding names differ/);
	});

	it('redacts every supplied value from mixed output', () => {
		const output = Object.values(secrets).join(' | ');
		const redacted = redactSecretText(output, secrets);
		for (const value of Object.values(secrets)) expect(redacted).not.toContain(value);
		expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(4);
	});
});
