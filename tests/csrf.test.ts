import { describe, expect, it } from 'vitest';
import {
	createCsrfToken,
	MutationSecurityError,
	PRODUCTION_EDITORIAL_ORIGIN,
	verifySameOriginMutation,
} from '../src/security/csrf';

function mutationRequest(
	token: string,
	origin = PRODUCTION_EDITORIAL_ORIGIN,
	requestUrl = `${PRODUCTION_EDITORIAL_ORIGIN}/editorial/actions/stories`,
): Request {
	const form = new FormData();
	form.set('csrf_token', token);
	form.set('action', 'update');
	return new Request(requestUrl, {
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

	it('uses the canonical browser origin when an Access-fronted Worker has an internal request origin', async () => {
		const token = createCsrfToken();
		const request = mutationRequest(
			token,
			PRODUCTION_EDITORIAL_ORIGIN,
			'https://tomorrow-ish.internal/editorial/actions/stories',
		);
		await expect(
			verifySameOriginMutation(request, token, PRODUCTION_EDITORIAL_ORIGIN),
		).resolves.toBeUndefined();
		await expect(verifySameOriginMutation(request, token)).rejects.toBeInstanceOf(
			MutationSecurityError,
		);
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
