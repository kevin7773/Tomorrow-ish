import { describe, expect, it, vi } from 'vitest';
import { OpenAIImageProvider } from '../src/images/openai-image-provider';

function webpBase64(): string {
	return btoa(String.fromCharCode(...new Uint8Array([
		0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
	])));
}

function successfulResponse(overrides: Record<string, unknown> = {}): Response {
	return new Response(JSON.stringify({
		created: 1_757_611_200,
		data: [{ b64_json: webpBase64() }],
		output_format: 'webp',
		quality: 'high',
		size: '1536x864',
		usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
		...overrides,
	}), { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_image_1' } });
}

describe('OpenAI image provider', () => {
	it('uses the Images API and returns validated WebP bytes', async () => {
		const fetcher = vi.fn().mockResolvedValue(successfulResponse());
		const provider = new OpenAIImageProvider('secret-key', 'gpt-image-2', fetcher);
		const result = await provider.generate({ prompt: 'Editorial illustration.', aspectRatio: '16:9' });

		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/images/generations');
		const init = fetcher.mock.calls[0][1] as RequestInit;
		expect(init.headers).toMatchObject({ Authorization: 'Bearer secret-key', 'Content-Type': 'application/json' });
		expect(JSON.parse(init.body as string)).toEqual({
			model: 'gpt-image-2',
			prompt: 'Editorial illustration.',
			n: 1,
			size: '1536x864',
			quality: 'high',
			background: 'opaque',
			moderation: 'auto',
			output_format: 'webp',
			output_compression: 90,
		});
		expect(result).toMatchObject({
			provider: 'openai',
			model: 'gpt-image-2',
			providerRequestId: 'req_image_1',
			contentType: 'image/webp',
			fileExtension: 'webp',
			generatedAt: '2025-09-11T17:20:00.000Z',
		});
		expect(result.bytes.byteLength).toBe(12);
		expect(result.metadata).toEqual({
			outputFormat: 'webp',
			quality: 'high',
			size: '1536x864',
			usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
		});
	});

	it('classifies authentication failures without persisting provider error bodies', async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			error: { message: 'secret diagnostic', api_key: 'must-not-persist' },
		}), { status: 401, headers: { 'x-request-id': 'req_auth_1' } }));
		const provider = new OpenAIImageProvider('secret-key', 'gpt-image-2', fetcher);

		await expect(provider.generate({ prompt: 'Editorial illustration.', aspectRatio: '16:9' }))
			.rejects.toMatchObject({
				failureClassification: 'PROVIDER_AUTHENTICATION',
				providerRequestId: 'req_auth_1',
				metadata: { httpStatus: 401 },
			});
	});

	it('rejects bytes that do not match the requested WebP format', async () => {
		const invalid = btoa(String.fromCharCode(...new Uint8Array([1, 2, 3, 4])));
		const provider = new OpenAIImageProvider('secret-key', 'gpt-image-2', vi.fn().mockResolvedValue(
			successfulResponse({ data: [{ b64_json: invalid }] }),
		));

		await expect(provider.generate({ prompt: 'Editorial illustration.', aspectRatio: '16:9' }))
			.rejects.toMatchObject({ failureClassification: 'PROVIDER_INVALID_OUTPUT' });
	});

	it('rejects an oversized declared response before reading its body', async () => {
		const response = successfulResponse();
		response.headers.set('Content-Length', String(17 * 1024 * 1024));
		const read = vi.spyOn(response, 'text');
		const provider = new OpenAIImageProvider('secret-key', 'gpt-image-2', vi.fn().mockResolvedValue(response));

		await expect(provider.generate({ prompt: 'Editorial illustration.', aspectRatio: '16:9' }))
			.rejects.toMatchObject({ failureClassification: 'PROVIDER_INVALID_OUTPUT' });
		expect(read).not.toHaveBeenCalled();
	});
});
