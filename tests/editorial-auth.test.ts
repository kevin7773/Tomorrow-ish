import { describe, expect, it, vi } from 'vitest';
import {
	authenticateEditorialRequest,
	EditorialAuthenticationError,
} from '../src/security/editorial-auth';

const environment = {
	CF_ACCESS_TEAM_DOMAIN: 'https://tomorrow-ish.cloudflareaccess.com',
	CF_ACCESS_AUD: 'access-audience',
	EDITORIAL_ALLOWED_EMAIL: 'newsgoblin@tomorrow-ish.news',
};

describe('Cloudflare Access authentication', () => {
	it('fails closed when production configuration is missing', async () => {
		await expect(
			authenticateEditorialRequest(
				new Request('https://tomorrow-ish.news/editorial'),
				{},
			),
		).rejects.toBeInstanceOf(EditorialAuthenticationError);
	});

	it('fails closed when the Access assertion is missing', async () => {
		await expect(
			authenticateEditorialRequest(
				new Request('https://tomorrow-ish.news/editorial'),
				environment,
			),
		).rejects.toBeInstanceOf(EditorialAuthenticationError);
	});

	it('validates audience configuration and the exact authorized email', async () => {
		const verifyToken = vi.fn().mockResolvedValue({ email: 'newsgoblin@tomorrow-ish.news' });
		const identity = await authenticateEditorialRequest(
			new Request('https://tomorrow-ish.news/editorial', {
				headers: { 'Cf-Access-Jwt-Assertion': 'signed-token' },
			}),
			environment,
			{ verifyToken },
		);
		expect(identity).toEqual({ email: 'newsgoblin@tomorrow-ish.news' });
		expect(verifyToken).toHaveBeenCalledWith('signed-token', {
			teamDomain: 'https://tomorrow-ish.cloudflareaccess.com',
			audience: 'access-audience',
			allowedEmail: 'newsgoblin@tomorrow-ish.news',
		});

		await expect(
			authenticateEditorialRequest(
				new Request('https://tomorrow-ish.news/editorial', {
					headers: { 'Cf-Access-Jwt-Assertion': 'signed-token' },
				}),
				environment,
				{ verifyToken: async () => ({ email: 'someone@example.com' }) },
			),
		).rejects.toBeInstanceOf(EditorialAuthenticationError);
	});

	it('allows the fixed local identity only for an explicitly enabled localhost request', async () => {
		await expect(
			authenticateEditorialRequest(new Request('https://tomorrow-ish.news/editorial'), {}, {
				allowLocalDevelopment: true,
			}),
		).rejects.toBeInstanceOf(EditorialAuthenticationError);

		await expect(
			authenticateEditorialRequest(new Request('http://localhost:4321/editorial'), {}, {
				allowLocalDevelopment: true,
			}),
		).resolves.toEqual({ email: 'newsgoblin@tomorrow-ish.news' });
	});
});
