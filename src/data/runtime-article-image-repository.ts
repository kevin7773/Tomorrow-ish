import { env } from 'cloudflare:workers';
import { R2ImageAssetStore } from '../images/asset-store';
import { D1ArticleImageRepository } from './d1-article-image-repository';

export function getArticleImageRepository(): D1ArticleImageRepository {
	return new D1ArticleImageRepository(env.DB);
}

export function getArticleImageAssetStore(): R2ImageAssetStore {
	return new R2ImageAssetStore(env.IMAGE_ASSETS);
}
