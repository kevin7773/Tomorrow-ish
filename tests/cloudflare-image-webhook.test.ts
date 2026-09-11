import { describe, expect, it } from 'vitest';
import {
	MAX_CLOUDFLARE_WEBHOOK_BODY_CHARACTERS,
	parseCloudflareImageWebhook,
	readCloudflareImageWebhookRequest,
} from '../src/images/cloudflare-image-webhook';

describe('Cloudflare image webhook payload validation', () => {
	it('keeps only the run ID, result URL, state, safe identifiers, and numeric usage', () => {
		expect(parseCloudflareImageWebhook({
			id: 'run-1', state: 'Completed', provider: 'openai', model: 'openai/gpt-image-2',
			result: { image: 'https://asset.example.r2.dev/image.webp', ignored: 'secret' },
			usage: { total_tokens: 123, raw: 'ignored' }, ignored: 'secret',
		})).toEqual({
			providerRequestId: 'run-1', outcome: 'SUCCESS',
			resultUrl: 'https://asset.example.r2.dev/image.webp',
			metadata: {
				callbackState: 'Completed', callbackProvider: 'openai', callbackModel: 'openai/gpt-image-2',
				usage: { total_tokens: 123 },
			},
			errorClassification: null, errorMessage: null,
		});
	});

	it('sanitizes failures without retaining provider response messages', () => {
		const parsed = parseCloudflareImageWebhook({
			id: 'run-2', state: 'Failed', error: { type: 'provider_error', code: 10000, message: 'raw secret' },
		});
		expect(parsed).toMatchObject({
			outcome: 'FAILURE', errorClassification: 'PROVIDER_FAILED',
			metadata: { errorType: 'provider_error', errorCode: '10000' },
		});
		expect(JSON.stringify(parsed)).not.toContain('raw secret');
	});

	it('rejects unknown states and malformed success results', () => {
		expect(() => parseCloudflareImageWebhook({ id: 'run-1', state: 'Running' })).toThrow('state is unsupported');
		expect(() => parseCloudflareImageWebhook({ id: 'run-1', state: 'Completed', result: {} })).toThrow('no image');
	});

	it('rejects declared and actual oversized bodies and malformed JSON before domain processing', async () => {
		const declared = new Request('https://tomorrow-ish.news/webhook', {
			method: 'POST', body: '{}', headers: { 'content-length': String(MAX_CLOUDFLARE_WEBHOOK_BODY_CHARACTERS + 1) },
		});
		await expect(readCloudflareImageWebhookRequest(declared)).rejects.toThrow('oversized');
		const actual = new Request('https://tomorrow-ish.news/webhook', {
			method: 'POST', body: 'x'.repeat(MAX_CLOUDFLARE_WEBHOOK_BODY_CHARACTERS + 1),
		});
		await expect(readCloudflareImageWebhookRequest(actual)).rejects.toThrow('invalid');
		await expect(readCloudflareImageWebhookRequest(new Request('https://tomorrow-ish.news/webhook', {
			method: 'POST', body: '{',
		}))).rejects.toThrow('malformed');
	});
});
