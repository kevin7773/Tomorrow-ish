import type { APIRoute } from 'astro';
import { getArticleImageAssetStore, getArticleImageRepository } from '../../../data/runtime-article-image-repository';
import { getEditorialRepository } from '../../../data/runtime-editorial-repository';
import { getImageProvider } from '../../../images/runtime-image-provider';
import {
	actionErrorResponse,
	redirectWithResult,
	requireEditor,
	safeReturnPath,
} from '../../../lib/editorial-actions';
import { ArticleImageService } from '../../../services/article-image-service';
import { getAsyncArticleImageService, getImageWebhookUrl } from '../../../services/runtime-async-article-image-service';

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/stories');
	try {
		const imageRepository = getArticleImageRepository();
		const action = form.get('action');
		const provider = action === 'generate' ? getImageProvider() : {
			provider: 'unused', model: 'unused', lifecycle: 'synchronous' as const,
			generate: async () => { throw new Error('unreachable'); },
		};
		const asyncService = getAsyncArticleImageService(imageRepository, getArticleImageAssetStore());
		const service = new ArticleImageService(
			getEditorialRepository(),
			imageRepository,
			provider,
			getArticleImageAssetStore(),
			{
				createWebhookUrl: getImageWebhookUrl,
				processStoredWebhook: (imageId) => asyncService.processStoredWebhook(imageId).then(() => undefined),
			},
		);
		const identity = requireEditor(context);
		const input = {
			storyId: form.get('storyId'),
			imageId: form.get('imageId'),
			altText: form.get('altText'),
		};
		switch (action) {
			case 'generate': {
				const result = await service.generate(identity, input);
				if (result.status === 'GENERATION_FAILED') {
					return redirectWithResult(returnPath, 'error', 'image-provider-unavailable');
				}
				return redirectWithResult(returnPath, 'message', result.status === 'PENDING' ? 'image-pending' : 'image-generated');
			}
			case 'resolve-pending':
				await service.resolveStalePending(identity, input);
				return redirectWithResult(returnPath, 'message', 'image-pending-resolved');
			case 'approve':
				await service.approve(identity, input);
				return redirectWithResult(returnPath, 'message', 'image-approved');
			case 'reject':
				await service.reject(identity, input);
				return redirectWithResult(returnPath, 'message', 'image-rejected');
			case 'regenerate':
				await service.requestRegeneration(identity, input);
				return redirectWithResult(returnPath, 'message', 'image-regeneration-requested');
			default:
				return redirectWithResult(returnPath, 'error', 'invalid-request');
		}
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
