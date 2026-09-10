import { describe, expect, it } from 'vitest';
import {
	createCsrfToken,
	MutationSecurityError,
	verifySameOriginMutation,
} from '../src/security/csrf';

function mutationRequest(token: string, origin = 'https://tomorrow-ish.news'): Request {
	const form = new FormData();
	form.set('csrf_token', token);
	form.set('action', 'update');
	return new Request('https://tomorrow-ish.news/editorial/actions/stories', {
		method: 'POST',
		headers: { Origin: origin },
		body: form,
	});
}

describe('editorial mutation protection', () => {
	it('accepts a same-origin POST with matching cookie and form tokens', async () => {
		const token = createCsrfToken();
		await expect(verifySameOriginMutation(mutationRequest(token), token)).resolves.toBeUndefined();
	});

	it('rejects cross-origin, missing-cookie, and mismatched-token requests', async () => {
		const token = createCsrfToken();
		await expect(
			verifySameOriginMutation(mutationRequest(token, 'https://attacker.example'), token),
		).rejects.toBeInstanceOf(MutationSecurityError);
		await expect(verifySameOriginMutation(mutationRequest(token), undefined)).rejects.toBeInstanceOf(
			MutationSecurityError,
		);
		await expect(
			verifySameOriginMutation(mutationRequest(createCsrfToken()), token),
		).rejects.toBeInstanceOf(MutationSecurityError);
	});
});
