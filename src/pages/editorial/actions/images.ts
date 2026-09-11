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

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/stories');
	try {
		const imageRepository = getArticleImageRepository();
		const action = form.get('action');
		const provider = action === 'generate' ? getImageProvider() : {
			provider: 'unused', model: 'unused', generate: async () => { throw new Error('unreachable'); },
		};
		const service = new ArticleImageService(
			getEditorialRepository(),
			imageRepository,
			provider,
			getArticleImageAssetStore(),
		);
		const identity = requireEditor(context);
		const input = {
			storyId: form.get('storyId'),
			imageId: form.get('imageId'),
			altText: form.get('altText'),
		};
		switch (action) {
			case 'generate':
				await service.generate(identity, input);
				return redirectWithResult(returnPath, 'message', 'image-generated');
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
