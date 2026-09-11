import { env } from 'cloudflare:workers';
import type { ArticleImageRepository } from '../data/article-image-repository';
import { getArticleImageAssetStore, getArticleImageRepository } from '../data/runtime-article-image-repository';
import { createImageWebhookUrl } from '../images/image-webhook-auth';
import type { ImageAssetStore } from '../images/asset-store';
import { AsyncArticleImageService } from './async-article-image-service';

export function getAsyncArticleImageService(
	repository: ArticleImageRepository = getArticleImageRepository(),
	assetStore: ImageAssetStore = getArticleImageAssetStore(),
): AsyncArticleImageService {
	return new AsyncArticleImageService(repository, assetStore);
}

export function getImageWebhookUrl(imageId: string): Promise<string> {
	return createImageWebhookUrl(env.IMAGE_WEBHOOK_ORIGIN, imageId, env.IMAGE_WEBHOOK_SECRET);
}
