import { describe, expect, it, vi } from 'vitest';
import { CloudflareGatewayImageProvider } from '../src/images/cloudflare-gateway-image-provider';

const ACCOUNT_ID = '1234567890abcdef1234567890abcdef';

describe('Cloudflare AI Gateway asynchronous image provider', () => {
	it('submits exactly one background GPT Image 2 request and returns its run ID', async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			success: true,
			result: { id: 'run-123', state: 'Pending' },
		}), { status: 200, headers: { 'cf-ray': 'ray-123' } }));
		const provider = new CloudflareGatewayImageProvider(
			ACCOUNT_ID, 'cloudflare-token', 'tomorrow-ish-images', 'openai/gpt-image-2', fetcher,
		);

		await expect(provider.submit({
			prompt: 'An office plant portrayed as a middle manager.',
			aspectRatio: '16:9',
			webhookUrl: 'https://tomorrow-ish.news/api/image-generation/webhook/image-1?signature=test',
		})).resolves.toMatchObject({
			provider: 'cloudflare-ai-gateway',
			model: 'openai/gpt-image-2',
			providerRequestId: 'run-123',
		});

		expect(fetcher).toHaveBeenCalledOnce();
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run`);
		expect(init).toMatchObject({ method: 'POST' });
		expect(init.headers).toMatchObject({
			Authorization: 'Bearer cloudflare-token',
			'Content-Type': 'application/json',
			'cf-aig-gateway-id': 'tomorrow-ish-images',
			'cf-aig-max-attempts': '1',
			'cf-aig-collect-log-payload': 'false',
		});
		expect(JSON.parse(init.body)).toEqual({
			model: 'openai/gpt-image-2',
			input: {
				prompt: 'An office plant portrayed as a middle manager.',
				quality: 'medium', size: '1536x1024', background: 'opaque', output_format: 'webp',
			},
			options: {
				background: true,
				webhookUrl: 'https://tomorrow-ish.news/api/image-generation/webhook/image-1?signature=test',
			},
		});
	});

	it('does not retry and preserves only safe rejection diagnostics', async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			errors: [{ code: 10000, message: 'sensitive upstream message' }],
		}), { status: 401, headers: { 'cf-ray': 'ray-safe' } }));
		const provider = new CloudflareGatewayImageProvider(
			ACCOUNT_ID, 'cloudflare-token', 'tomorrow-ish-images', 'openai/gpt-image-2', fetcher,
		);
		await expect(provider.submit({
			prompt: 'Safe prompt', aspectRatio: '16:9', webhookUrl: 'https://tomorrow-ish.news/callback',
		})).rejects.toMatchObject({
			failureClassification: 'PROVIDER_AUTHENTICATION',
			metadata: { httpStatus: 401, cloudflareRequestId: 'ray-safe', errorCode: '10000' },
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('rejects missing run IDs and invalid configuration', async () => {
		const provider = new CloudflareGatewayImageProvider(
			ACCOUNT_ID, 'cloudflare-token', 'tomorrow-ish-images', 'openai/gpt-image-2',
			vi.fn().mockResolvedValue(Response.json({ success: true, result: { state: 'Pending' } })),
		);
		await expect(provider.submit({
			prompt: 'Safe prompt', aspectRatio: '16:9', webhookUrl: 'https://tomorrow-ish.news/callback',
		})).rejects.toMatchObject({ failureClassification: 'PROVIDER_INVALID_OUTPUT' });
		expect(() => new CloudflareGatewayImageProvider('bad', 'token', 'gateway', 'openai/gpt-image-2'))
			.toThrow('account configuration');
	});
});
