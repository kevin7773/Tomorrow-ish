import { describe, expect, it } from 'vitest';
import { createImageWebhookUrl, verifyImageWebhookSignature } from '../src/images/image-webhook-auth';

describe('image webhook capability authentication', () => {
	it('accepts only the HMAC bound to the persisted image ID', async () => {
		const secret = 'test-only-secret-that-is-at-least-32-bytes';
		const url = new URL(await createImageWebhookUrl('https://tomorrow-ish.news', 'image-1', secret));
		const signature = url.searchParams.get('signature') ?? '';
		expect(await verifyImageWebhookSignature('image-1', signature, secret)).toBe(true);
		expect(await verifyImageWebhookSignature('image-2', signature, secret)).toBe(false);
		expect(await verifyImageWebhookSignature('image-1', `${signature}x`, secret)).toBe(false);
		expect(await verifyImageWebhookSignature('image-1', signature, 'too-short')).toBe(false);
		await expect(createImageWebhookUrl('https://tomorrow-ish.news', 'image-1', 'too-short')).rejects.toThrow('too short');
		expect(url.pathname).toBe('/api/image-generation/webhook/image-1');
	});
});
