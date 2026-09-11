import type { EditorialStory } from '../domain/editorial';

export const ARTICLE_IMAGE_PROMPT_VERSION = 'tomorrow-ish-editorial-v1';
export const ARTICLE_IMAGE_HOUSE_DIRECTION =
	'Editorial news illustration, subtly absurd but visually plausible, polished magazine/news-site quality, strong composition, slightly cinematic, no embedded text, no logos, no watermarks.';

function cleanConcept(value: string): string {
	return value
		.replace(/[#*_>`~\[\]()]/g, ' ')
		.replace(/https?:\/\/\S+/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.split(/(?<=[.!?])\s+/)[0]
		.slice(0, 280)
		.replace(/[,:;\s]+$/, '');
}

export interface ArticleImagePrompt {
	prompt: string;
	proposedAltText: string;
	promptVersion: string;
}

export function produceArticleImagePrompt(story: EditorialStory): ArticleImagePrompt {
	const centralConcept = cleanConcept(story.deck || story.socialExcerpt || story.bodyMarkdown);
	const premise = cleanConcept(story.headline);
	const prompt = [
		ARTICLE_IMAGE_HOUSE_DIRECTION,
		`Create an original editorial illustration for the ${story.category.name} section.`,
		`Central visual concept: ${centralConcept}.`,
		`Satirical premise: ${premise}.`,
		'Treat the scene as clearly illustrative rather than documentary photographic evidence of a real event.',
		'Landscape composition, 16:9, with a clear focal subject and room for responsive crops.',
	].join(' ');

	return {
		prompt,
		proposedAltText: `Editorial illustration of ${centralConcept.replace(/^[A-Z]/, (letter) => letter.toLowerCase())}.`,
		promptVersion: ARTICLE_IMAGE_PROMPT_VERSION,
	};
}
