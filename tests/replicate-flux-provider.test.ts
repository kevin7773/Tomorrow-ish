import { describe, expect, it, vi } from 'vitest';
import { ReplicateFluxProvider } from '../src/images/replicate-flux-provider';

describe('Replicate FLUX image provider', () => {
	function prediction(output = 'https://replicate.delivery/output.webp'): Response {
		return new Response(JSON.stringify({
			id: 'prediction-1', model: 'black-forest-labs/flux-2-pro', version: 'version-1',
			status: 'succeeded', output, completed_at: '2026-09-11T12:00:01.000Z',
		}), { status: 201, headers: { 'Content-Type': 'application/json' } });
	}

	it('uses the official-model endpoint and returns downloaded image bytes', async () => {
		const fetcher = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				id: 'prediction-1', model: 'black-forest-labs/flux-2-pro', version: 'version-1',
				status: 'succeeded', output: 'https://replicate.delivery/output.webp',
				completed_at: '2026-09-11T12:00:01.000Z', metrics: { predict_time: 1 },
			}), { status: 201, headers: { 'Content-Type': 'application/json' } }))
			.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/webp' } }));
		const provider = new ReplicateFluxProvider('secret-token', 'black-forest-labs/flux-2-pro', fetcher);
		const result = await provider.generate({ prompt: 'Editorial illustration.', aspectRatio: '16:9' });

		expect(fetcher.mock.calls[0][0]).toBe('https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions');
		const init = fetcher.mock.calls[0][1] as RequestInit;
		expect(init.headers).toMatchObject({ Prefer: 'wait=60', 'Cancel-After': '60s' });
		expect(JSON.parse(init.body as string)).toEqual({ input: {
			prompt: 'Editorial illustration.', aspect_ratio: '16:9', output_format: 'webp', output_quality: 90, safety_tolerance: 2,
		} });
		expect(result).toMatchObject({ provider: 'replicate', model: 'black-forest-labs/flux-2-pro', providerRequestId: 'prediction-1', contentType: 'image/webp' });
		expect(result.bytes.byteLength).toBe(3);
	});

	it('rejects unsupported image MIME types before returning bytes for storage', async () => {
		const fetcher = vi.fn()
			.mockResolvedValueOnce(prediction())
			.mockResolvedValueOnce(new Response('<svg/>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }));
		const provider = new ReplicateFluxProvider('secret-token', 'black-forest-labs/flux-2-pro', fetcher);
		await expect(provider.generate({ prompt: 'Editorial illustration.', aspectRatio: '16:9' }))
			.rejects.toMatchObject({ failureClassification: 'PROVIDER_INVALID_OUTPUT' });
	});

	it('accepts a synchronous file output that is ready while prediction status is still processing', async () => {
		const processing = new Response(JSON.stringify({
			id: 'prediction-2', model: 'black-forest-labs/flux-2-pro', status: 'processing',
			output: 'https://replicate.delivery/ready.webp',
		}), { status: 201, headers: { 'Content-Type': 'application/json' } });
		const fetcher = vi.fn()
			.mockResolvedValueOnce(processing)
			.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Type': 'image/webp' } }));
		const provider = new ReplicateFluxProvider('secret-token', 'black-forest-labs/flux-2-pro', fetcher);
		await expect(provider.generate({ prompt: 'Editorial illustration.', aspectRatio: '16:9' }))
			.resolves.toMatchObject({ providerRequestId: 'prediction-2', contentType: 'image/webp' });
	});

	it('rejects a declared oversized download before reading or returning it for storage', async () => {
		const oversized = new Response(new Uint8Array([1]), {
			status: 200,
			headers: { 'Content-Type': 'image/webp', 'Content-Length': String(12 * 1024 * 1024 + 1) },
		});
		const arrayBuffer = vi.spyOn(oversized, 'arrayBuffer');
		const fetcher = vi.fn().mockResolvedValueOnce(prediction()).mockResolvedValueOnce(oversized);
		const provider = new ReplicateFluxProvider('secret-token', 'black-forest-labs/flux-2-pro', fetcher);
		await expect(provider.generate({ prompt: 'Editorial illustration.', aspectRatio: '16:9' }))
			.rejects.toMatchObject({ failureClassification: 'PROVIDER_INVALID_OUTPUT' });
		expect(arrayBuffer).not.toHaveBeenCalled();
	});
});
