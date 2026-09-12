import type { ArticleImageRepository, ImageWebhookInboxRecord } from '../data/article-image-repository';
import type { ImageAssetStore } from '../images/asset-store';
import { downloadCloudflareImage } from '../images/cloudflare-image-result';
import type { CloudflareImageWebhook } from '../images/cloudflare-image-webhook';
import { ImageProviderError } from '../images/image-provider';

export type AsyncWebhookResult = 'processed' | 'deferred' | 'idempotent' | 'unknown' | 'conflict';

export interface AsyncArticleImageServiceDependencies {
	now?: () => string;
	createId?: () => string;
	fetcher?: typeof fetch;
}

async function deleteBestEffort(assetStore: ImageAssetStore, key: string): Promise<boolean> {
	try {
		await assetStore.delete(key);
		return true;
	} catch {
		return false;
	}
}

export class AsyncArticleImageService {
	private readonly now: () => string;
	private readonly createId: () => string;
	private readonly fetcher: typeof fetch;

	constructor(
		private readonly imageRepository: ArticleImageRepository,
		private readonly assetStore: ImageAssetStore,
		dependencies: AsyncArticleImageServiceDependencies = {},
	) {
		this.now = dependencies.now ?? (() => new Date().toISOString());
		this.createId = dependencies.createId ?? (() => crypto.randomUUID());
		this.fetcher = dependencies.fetcher ?? fetch;
	}

	async acceptWebhook(imageId: string, callback: CloudflareImageWebhook): Promise<AsyncWebhookResult> {
		const image = await this.imageRepository.findById(imageId);
		if (!image) return 'unknown';
		if (image.provider !== 'cloudflare-ai-gateway') return 'conflict';
		if (image.status !== 'PENDING') {
			if (image.providerRequestId !== callback.providerRequestId) return 'conflict';
			const stored = await this.imageRepository.findWebhook(imageId);
			if (stored?.providerRequestId === callback.providerRequestId) {
				await this.imageRepository.markWebhookProcessed(imageId, callback.providerRequestId);
			}
			return 'idempotent';
		}
		if (image.providerRequestId && image.providerRequestId !== callback.providerRequestId) return 'conflict';
		if (image.providerRequestId) {
			const mapped = await this.imageRepository.findByProviderRequestId(image.provider, callback.providerRequestId);
			if (!mapped || mapped.id !== image.id) return 'conflict';
		}

		const recorded = await this.imageRepository.recordWebhook({
			imageId,
			providerRequestId: callback.providerRequestId,
			outcome: callback.outcome,
			resultUrl: callback.resultUrl,
			metadata: callback.metadata,
			errorClassification: callback.errorClassification,
			errorMessage: callback.errorMessage,
			receivedAt: this.now(),
		});
		if (recorded === 'conflict') return 'conflict';
		if (!image.providerRequestId) {
			const attached = await this.imageRepository.attachSubmission({
				imageId,
				providerRequestId: callback.providerRequestId,
				metadata: { ...image.metadata, providerRequestIdSource: 'webhook' },
				submittedAt: this.now(),
				auditId: this.createId(),
			});
			if (!attached) {
				const current = await this.imageRepository.findById(imageId);
				if (current?.providerRequestId !== callback.providerRequestId) return 'conflict';
			}
		}
		return this.processStoredWebhook(imageId);
	}

	async processStoredWebhook(imageId: string): Promise<AsyncWebhookResult> {
		const [image, callback] = await Promise.all([
			this.imageRepository.findById(imageId),
			this.imageRepository.findWebhook(imageId),
		]);
		if (!image) return 'unknown';
		if (!callback) return 'deferred';
		if (image.status !== 'PENDING') {
			await this.imageRepository.markWebhookProcessed(imageId, callback.providerRequestId);
			return image.providerRequestId === callback.providerRequestId ? 'idempotent' : 'conflict';
		}
		if (!image.providerRequestId) return 'deferred';
		if (image.providerRequestId !== callback.providerRequestId) return 'conflict';
		const mapped = await this.imageRepository.findByProviderRequestId(image.provider, callback.providerRequestId);
		if (!mapped || mapped.id !== image.id) return 'conflict';
		if (callback.processingState === 'PROCESSED') return 'idempotent';
		if (callback.processingState === 'PROCESSING') return 'deferred';
		if (!await this.imageRepository.claimWebhook(imageId, callback.providerRequestId)) return 'deferred';

		if (callback.outcome === 'FAILURE') {
			await this.failPending(imageId, callback);
			await this.imageRepository.markWebhookProcessed(imageId, callback.providerRequestId);
			return 'processed';
		}

		const assetKey = `article-images/${image.storyId}/${image.id}.webp`;
		let stored = false;
		try {
			const result = await downloadCloudflareImage(callback.resultUrl ?? '', this.fetcher);
			let asset;
			try {
				asset = await this.assetStore.put(assetKey, result.bytes, result.contentType);
			} catch {
				throw new ImageProviderError(
					'The generated image could not be copied to durable storage.',
					'ASSET_STORAGE_FAILED',
					callback.providerRequestId,
				);
			}
			stored = true;
			let completed: boolean;
			try {
				completed = await this.imageRepository.completePending({
					imageId,
					providerRequestId: callback.providerRequestId,
					assetKey: asset.key,
					contentType: asset.contentType,
					byteSize: asset.byteSize,
					metadata: {
						...image.metadata,
						...callback.metadata,
						width: result.width,
						height: result.height,
						outputFormat: result.fileExtension,
					},
					generatedAt: this.now(),
					auditId: this.createId(),
				});
			} catch (error) {
				await deleteBestEffort(this.assetStore, asset.key);
				throw error;
			}
			if (!completed) {
				await deleteBestEffort(this.assetStore, asset.key);
				throw new ImageProviderError('The pending image changed before completion.', 'PROVIDER_REQUEST');
			}
			await this.imageRepository.markWebhookProcessed(imageId, callback.providerRequestId);
			return 'processed';
		} catch (error) {
			if (!stored) await deleteBestEffort(this.assetStore, assetKey);
			if (error instanceof ImageProviderError) {
				try {
					await this.imageRepository.failPending({
						imageId,
						providerRequestId: callback.providerRequestId,
						metadata: { ...image.metadata, ...callback.metadata, ...error.metadata },
						errorClassification: error.failureClassification,
						errorMessage: error.message.slice(0, 500),
						failedAt: this.now(),
						auditId: this.createId(),
					});
					await this.imageRepository.markWebhookProcessed(imageId, callback.providerRequestId);
					return 'processed';
				} catch (persistenceError) {
					await this.imageRepository.releaseWebhook(imageId, callback.providerRequestId);
					throw persistenceError;
				}
			}
			await this.imageRepository.releaseWebhook(imageId, callback.providerRequestId);
			throw error;
		}
	}

	private async failPending(imageId: string, callback: ImageWebhookInboxRecord): Promise<void> {
		await this.imageRepository.failPending({
			imageId,
			providerRequestId: callback.providerRequestId,
			metadata: callback.metadata,
			errorClassification: callback.errorClassification ?? 'PROVIDER_FAILED',
			errorMessage: callback.errorMessage ?? 'Cloudflare AI Gateway reported that image generation failed.',
			failedAt: this.now(),
			auditId: this.createId(),
		});
	}
}
