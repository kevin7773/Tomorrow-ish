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
	secFetchSite?: string,
): Request {
	const form = new FormData();
	form.set('csrf_token', token);
	form.set('action', 'update');
	return new Request(requestUrl, {
		method: 'POST',
		headers: {
			Origin: origin,
			...(secFetchSite ? { 'Sec-Fetch-Site': secFetchSite } : {}),
		},
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

	it('accepts an opaque in-app-browser origin only with canonical same-origin fetch metadata', async () => {
		const token = createCsrfToken();
		await expect(
			verifySameOriginMutation(
				mutationRequest(token, 'null', undefined, 'same-origin'),
				token,
				PRODUCTION_EDITORIAL_ORIGIN,
			),
		).resolves.toBeUndefined();

		await expect(
			verifySameOriginMutation(
				mutationRequest(token, 'null', undefined, 'cross-site'),
				token,
				PRODUCTION_EDITORIAL_ORIGIN,
			),
		).rejects.toMatchObject({ reason: 'origin-mismatch' });
		await expect(
			verifySameOriginMutation(mutationRequest(token, 'null'), token, PRODUCTION_EDITORIAL_ORIGIN),
		).rejects.toMatchObject({ reason: 'origin-mismatch' });
		await expect(
			verifySameOriginMutation(
				mutationRequest(
					token,
					'null',
					'https://tomorrow-ish.internal/editorial/actions/stories',
					'same-origin',
				),
				token,
				PRODUCTION_EDITORIAL_ORIGIN,
			),
		).rejects.toMatchObject({ reason: 'origin-mismatch' });
	});

	it('rejects cross-origin, missing-cookie, and mismatched-token requests', async () => {
		const token = createCsrfToken();
		await expect(
			verifySameOriginMutation(mutationRequest(token, 'https://attacker.example'), token),
		).rejects.toMatchObject({ reason: 'origin-mismatch' });
		await expect(verifySameOriginMutation(mutationRequest(token), undefined)).rejects.toMatchObject({
			reason: 'invalid-cookie-token',
		});
		await expect(
			verifySameOriginMutation(mutationRequest(createCsrfToken()), token),
		).rejects.toMatchObject({ reason: 'token-mismatch' });
	});
});
