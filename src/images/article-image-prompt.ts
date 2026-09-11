import type { EditorialStory } from '../domain/editorial';

export const ARTICLE_IMAGE_PROMPT_VERSION = 'tomorrow-ish-editorial-v2';
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

function isInternalEditorialText(value: string): boolean {
	return [
		/\b(?:draft|review|approved|rejected|published|unpublished)\s+(?:story|item|content|candidate|record)\b/i,
		/\b(?:do not publish|must never appear|before publication|publication boundary|publication-state)\b/i,
		/\b(?:test|testing|fixture|scaffold(?:ing)?)\b/i,
		/\bexists only to (?:verify|test)\b/i,
	].some((pattern) => pattern.test(value));
}

function lowerFirst(value: string): string {
	return value.replace(/^[A-Z]/, (letter) => letter.toLowerCase());
}

export interface ArticleImagePrompt {
	prompt: string;
	proposedAltText: string;
	promptVersion: string;
}

export function produceArticleImagePrompt(story: EditorialStory): ArticleImagePrompt {
	const premise = cleanConcept(story.headline);
	if (!premise || isInternalEditorialText(premise)) {
		throw new Error('The story does not contain a reader-facing image premise.');
	}
	const supportingConcept = [story.deck, story.socialExcerpt, story.bodyMarkdown]
		.map(cleanConcept)
		.find((value) => value.length > 0 && !isInternalEditorialText(value));
	const centralConcept = supportingConcept
		?? `A literal visual interpretation of ${lowerFirst(premise)}, staged in a recognizable ${story.category.name.toLowerCase()} setting with subtle satirical details`;
	const altConcept = supportingConcept ?? lowerFirst(premise);
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
		proposedAltText: `Editorial illustration of ${lowerFirst(altConcept)}.`,
		promptVersion: ARTICLE_IMAGE_PROMPT_VERSION,
	};
}
