import { describe, expect, it, vi } from 'vitest';
import type { ArticleImageRepository, ImageWebhookInboxRecord } from '../src/data/article-image-repository';
import type { ArticleImage } from '../src/domain/article-image';
import type { ImageAssetStore } from '../src/images/asset-store';
import type { CloudflareImageWebhook } from '../src/images/cloudflare-image-webhook';
import { downloadCloudflareImage } from '../src/images/cloudflare-image-result';
import { AsyncArticleImageService } from '../src/services/async-article-image-service';

const now = '2026-09-11T12:30:00.000Z';

function pendingImage(overrides: Partial<ArticleImage> = {}): ArticleImage {
	return {
		id: 'image-1', storyId: 'story-1', provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2',
		prompt: 'A clearly illustrative satirical office scene.', aspectRatio: '16:9', providerRequestId: 'run-1',
		assetKey: null, contentType: null, byteSize: null, status: 'PENDING',
		altText: 'Editorial illustration of an office plant acting as a manager.', metadata: { submissionState: 'queued' },
		errorClassification: null, errorMessage: null, requestedByEmail: 'editor@tomorrow-ish.news',
		requestedAt: '2026-09-11T12:00:00.000Z', generatedAt: null, reviewedByEmail: null, reviewedAt: null,
		...overrides,
	};
}

function successCallback(id = 'run-1'): CloudflareImageWebhook {
	return {
		providerRequestId: id, outcome: 'SUCCESS', resultUrl: 'https://result.example.r2.dev/image.webp',
		metadata: { callbackState: 'completed' }, errorClassification: null, errorMessage: null,
	};
}

function failureCallback(id = 'run-1'): CloudflareImageWebhook {
	return {
		providerRequestId: id, outcome: 'FAILURE', resultUrl: null,
		metadata: { callbackState: 'failed', errorCode: 'provider_error' },
		errorClassification: 'PROVIDER_FAILED', errorMessage: 'Cloudflare AI Gateway reported that image generation failed.',
	};
}

function validWebp(): Uint8Array {
	const bytes = new Uint8Array(30);
	bytes.set([...Buffer.from('RIFF')], 0);
	bytes.set([...Buffer.from('WEBP')], 8);
	bytes.set([...Buffer.from('VP8X')], 12);
	bytes[24] = 0xff; bytes[25] = 0x05; // 1536 - 1
	bytes[27] = 0xff; bytes[28] = 0x03; // 1024 - 1
	return bytes;
}

function validWebpBody(): ArrayBuffer {
	return validWebp().buffer as ArrayBuffer;
}

function setup(initial = pendingImage()) {
	let image: ArticleImage | null = initial;
	let inbox: ImageWebhookInboxRecord | null = null;
	const repository = {
		findById: vi.fn(async () => image),
		findByProviderRequestId: vi.fn(async (_provider: string, requestId: string) =>
			image?.providerRequestId === requestId ? image : null),
		attachSubmission: vi.fn(async (record) => {
			if (!image || image.status !== 'PENDING' || image.providerRequestId !== null) return false;
			image = { ...image, providerRequestId: record.providerRequestId, metadata: record.metadata };
			return true;
		}),
		recordWebhook: vi.fn(async (record: Omit<ImageWebhookInboxRecord, 'processingState'>) => {
			if (inbox) {
				return inbox.providerRequestId === record.providerRequestId && inbox.outcome === record.outcome
					&& inbox.resultUrl === record.resultUrl ? 'duplicate' : 'conflict';
			}
			inbox = { ...record, processingState: 'RECEIVED' };
			return 'created';
		}),
		findWebhook: vi.fn(async () => inbox),
		claimWebhook: vi.fn(async (_imageId: string, requestId: string) => {
			if (!inbox || inbox.providerRequestId !== requestId || inbox.processingState !== 'RECEIVED') return false;
			inbox = { ...inbox, processingState: 'PROCESSING' };
			return true;
		}),
		releaseWebhook: vi.fn(async (_imageId: string, requestId: string) => {
			if (inbox?.providerRequestId === requestId && inbox.processingState === 'PROCESSING') {
				inbox = { ...inbox, processingState: 'RECEIVED' };
			}
		}),
		markWebhookProcessed: vi.fn(async () => {
			if (inbox) inbox = { ...inbox, processingState: 'PROCESSED' };
		}),
		completePending: vi.fn(async (record) => {
			if (!image || image.status !== 'PENDING' || image.providerRequestId !== record.providerRequestId) return false;
			image = {
				...image, status: 'GENERATED', assetKey: record.assetKey, contentType: record.contentType,
				byteSize: record.byteSize, metadata: record.metadata, generatedAt: record.generatedAt,
			};
			return true;
		}),
		failPending: vi.fn(async (record) => {
			if (!image || image.status !== 'PENDING') return false;
			image = {
				...image, status: 'GENERATION_FAILED', providerRequestId: record.providerRequestId,
				metadata: record.metadata, errorClassification: record.errorClassification, errorMessage: record.errorMessage,
			};
			return true;
		}),
	} as unknown as ArticleImageRepository;
	const assetStore: ImageAssetStore = {
		put: vi.fn(async (key, bytes, contentType) => ({ key, contentType, byteSize: bytes.byteLength })),
		delete: vi.fn(async () => undefined),
	};
	const fetcher = vi.fn(async () => new Response(validWebpBody(), {
		status: 200, headers: { 'content-type': 'image/webp', 'content-length': '30' },
	})) as unknown as typeof fetch;
	let id = 0;
	const service = new AsyncArticleImageService(repository, assetStore, {
		now: () => now, createId: () => `audit-${++id}`, fetcher,
	});
	return { service, repository, assetStore, fetcher, getImage: () => image, setImage: (value: ArticleImage) => { image = value; } };
}

describe('asynchronous article image completion', () => {
	it('completes an authenticated, persisted pending request and stores exactly one unapproved asset', async () => {
		const state = setup();
		await expect(state.service.acceptWebhook('image-1', successCallback())).resolves.toBe('processed');
		expect(state.assetStore.put).toHaveBeenCalledOnce();
		expect(state.fetcher).toHaveBeenCalledWith(
			new URL('https://result.example.r2.dev/image.webp'),
			expect.objectContaining({ method: 'GET', redirect: 'error' }),
		);
		expect(state.assetStore.put).toHaveBeenCalledWith(
			'article-images/story-1/image-1.webp', expect.any(ArrayBuffer), 'image/webp',
		);
		expect(state.repository.completePending).toHaveBeenCalledWith(expect.objectContaining({
			imageId: 'image-1', providerRequestId: 'run-1', byteSize: 30,
			metadata: expect.objectContaining({ width: 1536, height: 1024, outputFormat: 'webp' }),
		}));
		expect(state.getImage()).toMatchObject({
			status: 'GENERATED', storyId: 'story-1', assetKey: 'article-images/story-1/image-1.webp',
			altText: 'Editorial illustration of an office plant acting as a manager.', reviewedAt: null,
		});
	});

	it('treats a duplicate success callback as idempotent without storing twice', async () => {
		const state = setup();
		await expect(state.service.acceptWebhook('image-1', successCallback())).resolves.toBe('processed');
		await expect(state.service.acceptWebhook('image-1', successCallback())).resolves.toBe('idempotent');
		expect(state.assetStore.put).toHaveBeenCalledOnce();
		expect(state.repository.completePending).toHaveBeenCalledOnce();
	});

	it('marks provider failure terminally and never downloads or retries', async () => {
		const state = setup();
		await expect(state.service.acceptWebhook('image-1', failureCallback())).resolves.toBe('processed');
		expect(state.getImage()).toMatchObject({ status: 'GENERATION_FAILED', errorClassification: 'PROVIDER_FAILED' });
		expect(state.fetcher).not.toHaveBeenCalled();
		expect(state.assetStore.put).not.toHaveBeenCalled();
	});

	it('uses first terminal outcome wins for failure after success and success after failure', async () => {
		const successful = setup();
		await successful.service.acceptWebhook('image-1', successCallback());
		await expect(successful.service.acceptWebhook('image-1', failureCallback())).resolves.toBe('idempotent');
		expect(successful.getImage()?.status).toBe('GENERATED');

		const failed = setup();
		await failed.service.acceptWebhook('image-1', failureCallback());
		await expect(failed.service.acceptWebhook('image-1', successCallback())).resolves.toBe('idempotent');
		expect(failed.getImage()?.status).toBe('GENERATION_FAILED');
		expect(failed.assetStore.put).not.toHaveBeenCalled();
	});

	it('rejects unknown, wrong-provider, and mismatched request identifiers safely', async () => {
		const unknown = setup();
		vi.mocked(unknown.repository.findById).mockResolvedValueOnce(null);
		await expect(unknown.service.acceptWebhook('missing', successCallback())).resolves.toBe('unknown');

		const wrongProvider = setup(pendingImage({ provider: 'openai' }));
		await expect(wrongProvider.service.acceptWebhook('image-1', successCallback())).resolves.toBe('conflict');

		const mismatch = setup();
		await expect(mismatch.service.acceptWebhook('image-1', successCallback('run-other'))).resolves.toBe('conflict');
		expect(mismatch.repository.recordWebhook).not.toHaveBeenCalled();
	});

	it('attaches a later authenticated webhook run ID and processes the pending image', async () => {
		const state = setup(pendingImage({ providerRequestId: null }));
		await expect(state.service.acceptWebhook('image-1', successCallback())).resolves.toBe('processed');
		expect(state.repository.attachSubmission).toHaveBeenCalledWith(expect.objectContaining({
			imageId: 'image-1', providerRequestId: 'run-1',
			metadata: expect.objectContaining({ providerRequestIdSource: 'webhook' }),
		}));
		expect(state.getImage()?.providerRequestId).toBe('run-1');
		expect(state.assetStore.put).toHaveBeenCalledOnce();
	});

	it.each([
		['wrong MIME', new Response(validWebpBody(), { headers: { 'content-type': 'image/png' } })],
		['oversized body', new Response(validWebpBody(), { headers: { 'content-type': 'image/webp', 'content-length': String(13 * 1024 * 1024) } })],
		['bad signature', new Response(new ArrayBuffer(30), { headers: { 'content-type': 'image/webp' } })],
	])('fails safely for %s without retaining an R2 object', async (_name, response) => {
		const state = setup();
		vi.mocked(state.fetcher).mockResolvedValueOnce(response);
		await expect(state.service.acceptWebhook('image-1', successCallback())).resolves.toBe('processed');
		expect(state.getImage()?.status).toBe('GENERATION_FAILED');
		expect(state.assetStore.put).not.toHaveBeenCalled();
	});

	it('rejects a malicious result host before issuing a download', async () => {
		const state = setup();
		const callback = successCallback();
		callback.resultUrl = 'https://result.example.r2.dev.evil.example/image.webp';
		await expect(state.service.acceptWebhook('image-1', callback)).resolves.toBe('processed');
		expect(state.fetcher).not.toHaveBeenCalled();
		expect(state.assetStore.put).not.toHaveBeenCalled();
		expect(state.getImage()?.status).toBe('GENERATION_FAILED');
	});

	it('compensates an R2 write when D1 completion throws', async () => {
		const state = setup();
		vi.mocked(state.repository.completePending).mockRejectedValueOnce(new Error('D1 unavailable'));
		await expect(state.service.acceptWebhook('image-1', successCallback())).rejects.toThrow('D1 unavailable');
		expect(state.assetStore.put).toHaveBeenCalledOnce();
		expect(state.assetStore.delete).toHaveBeenCalledWith('article-images/story-1/image-1.webp');
		expect(state.repository.releaseWebhook).toHaveBeenCalledWith('image-1', 'run-1');
		expect(state.getImage()?.status).toBe('PENDING');
	});
});

describe('Cloudflare image result URL trust', () => {
	it.each([
		'https://pub-example.r2.dev/image.webp',
		'https://ai-gateway-outputs.0d37909e38d3e99c29fa2cd343ac421a.r2.cloudflarestorage.com/image.webp',
		'https://example-bucket.123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/image.webp',
	])('accepts a documented Cloudflare R2 host: %s', async (resultUrl) => {
		const fetcher = vi.fn(async () => new Response(validWebpBody(), {
			status: 200,
			headers: { 'content-type': 'image/webp', 'content-length': '30' },
		})) as unknown as typeof fetch;

		await expect(downloadCloudflareImage(resultUrl, fetcher)).resolves.toMatchObject({
			contentType: 'image/webp', width: 1536, height: 1024, byteSize: 30,
		});
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher).toHaveBeenCalledWith(
			new URL(resultUrl),
			expect.objectContaining({ method: 'GET', redirect: 'error' }),
		);
	});

	it.each([
		'https://r2.dev/image.webp',
		'https://r2.cloudflarestorage.com/image.webp',
		'https://r2.cloudflarestorage.com.evil.example/image.webp',
		'https://evil-r2.cloudflarestorage.com.evil.example/image.webp',
		'https://cloudflarestorage.com/image.webp',
		'https://foo.cloudflarestorage.com/image.webp',
		'https://evilr2.cloudflarestorage.com/image.webp',
		'https://asset.r2.dev@evil.example/image.webp',
		'https://user@asset.r2.dev/image.webp',
		'http://asset.r2.dev/image.webp',
		'ftp://asset.r2.dev/image.webp',
	])('rejects an untrusted or malformed authority before fetch: %s', async (resultUrl) => {
		const fetcher = vi.fn() as unknown as typeof fetch;
		await expect(downloadCloudflareImage(resultUrl, fetcher)).rejects.toMatchObject({
			failureClassification: 'PROVIDER_INVALID_OUTPUT',
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each([
		'https://next.example.r2.dev/image.webp',
		'https://evil.example/image.webp',
	])('does not follow redirects from an allowed host to %s', async (location) => {
		const fetcher = vi.fn(async () => new Response(null, {
			status: 302,
			headers: { location },
		})) as unknown as typeof fetch;

		await expect(downloadCloudflareImage(
			'https://source.example.r2.dev/image.webp',
			fetcher,
		)).rejects.toMatchObject({ failureClassification: 'PROVIDER_REQUEST' });
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher).toHaveBeenCalledWith(
			new URL('https://source.example.r2.dev/image.webp'),
			expect.objectContaining({ redirect: 'error' }),
		);
	});
});
