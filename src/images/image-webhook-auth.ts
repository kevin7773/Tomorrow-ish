const SIGNING_CONTEXT = 'tomorrow-ish:image-webhook:v1:';

function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function signature(secret: string, imageId: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
	);
	return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${SIGNING_CONTEXT}${imageId}`))));
}

function equalConstantTime(left: string, right: string): boolean {
	const length = Math.max(left.length, right.length);
	let difference = left.length ^ right.length;
	for (let index = 0; index < length; index += 1) {
		difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return difference === 0;
}

export async function createImageWebhookUrl(origin: string, imageId: string, secret: string): Promise<string> {
	if (new TextEncoder().encode(secret).byteLength < 32) {
		throw new Error('Image webhook signing credentials are missing or too short.');
	}
	const url = new URL(`/api/image-generation/webhook/${encodeURIComponent(imageId)}`, origin);
	if (url.protocol !== 'https:') throw new Error('Image webhook origin must use HTTPS.');
	url.searchParams.set('signature', await signature(secret, imageId));
	return url.toString();
}

export async function verifyImageWebhookSignature(imageId: string, supplied: string, secret: string): Promise<boolean> {
	if (new TextEncoder().encode(secret).byteLength < 32 || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
	return equalConstantTime(await signature(secret, imageId), supplied);
}
