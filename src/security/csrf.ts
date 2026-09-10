export const PRODUCTION_CSRF_COOKIE = '__Host-tomorrowish-csrf';
export const LOCAL_CSRF_COOKIE = 'tomorrowish-local-csrf';
export const PRODUCTION_EDITORIAL_ORIGIN = 'https://tomorrow-ish.news';

export type MutationSecurityReason =
	| 'invalid-method'
	| 'origin-mismatch'
	| 'invalid-cookie-token'
	| 'invalid-form-data'
	| 'token-mismatch';

export class MutationSecurityError extends Error {
	constructor(public readonly reason: MutationSecurityReason) {
		super('The request could not be verified.');
		this.name = 'MutationSecurityError';
	}
}

export function csrfCookieName(url: URL): string {
	return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
		? LOCAL_CSRF_COOKIE
		: PRODUCTION_CSRF_COOKIE;
}

export function createCsrfToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isValidCsrfToken(value: string | undefined): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function tokensEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
}

export async function verifySameOriginMutation(
	request: Request,
	cookieToken: string | undefined,
	expectedOrigin = new URL(request.url).origin,
): Promise<void> {
	if (request.method !== 'POST') throw new MutationSecurityError('invalid-method');
	if (request.headers.get('Origin') !== expectedOrigin) {
		throw new MutationSecurityError('origin-mismatch');
	}
	if (!isValidCsrfToken(cookieToken)) throw new MutationSecurityError('invalid-cookie-token');

	let form: FormData;
	try {
		form = await request.clone().formData();
	} catch {
		throw new MutationSecurityError('invalid-form-data');
	}
	const submittedToken = form.get('csrf_token');
	if (typeof submittedToken !== 'string' || !tokensEqual(cookieToken, submittedToken)) {
		throw new MutationSecurityError('token-mismatch');
	}
}
