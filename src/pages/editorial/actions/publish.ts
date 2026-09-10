import type { APIRoute } from 'astro';
import { getEditorialRepository } from '../../../data/runtime-editorial-repository';
import {
	actionErrorResponse,
	redirectWithResult,
	requireEditor,
	safeReturnPath,
} from '../../../lib/editorial-actions';
import { publishStory } from '../../../services/publication-service';

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/stories');
	try {
		await publishStory(
			getEditorialRepository(),
			requireEditor(context),
			{ storyId: form.get('storyId'), confirmation: form.get('confirmation') },
		);
		return redirectWithResult(returnPath, 'message', 'story-published');
	} catch (error) {
		return actionErrorResponse(error, returnPath);
	}
};
