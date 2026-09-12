import type { EditorialStory, SatireSuitability } from '../domain/editorial';
import type { GuardrailFlag } from '../domain/generation';

export const ARTICLE_IMAGE_PROMPT_VERSION = 'tomorrow-ish-editorial-v3';
export const ARTICLE_IMAGE_HOUSE_DIRECTION =
	'Editorial news illustration, subtly absurd but visually plausible, polished magazine/news-site quality, strong composition, slightly cinematic, no embedded text, no logos, no watermarks.';

function cleanText(value: string): string {
	return value
		.replace(/[#*_>`~\[\]()]/g, ' ')
		.replace(/https?:\/\/\S+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function cleanConcept(value: string): string {
	return cleanText(value)
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

export interface ArticleImagePromptGovernance {
	satireSuitability: SatireSuitability;
	guardrailFlags: readonly GuardrailFlag[];
	editorialCautionDirection: string;
	satiricalMechanism: string;
}

function approvedVisualDirection(value: string): string {
	const clauses = cleanText(value).split(/(?<=[.!?])\s+|;\s+/).filter(Boolean);
	const selected = clauses.find((clause) => /\b(?:focus|direct) (?:the )?satire\b/i.test(clause))
		?? clauses.find((clause) => !/^(?:avoid|do not|don't|never|not)\b/i.test(clause))
		?? '';
	return cleanConcept(selected)
		.split(/\s*(?:,|;|\.)\s*(?:not|avoid|do not)\b/i)[0]
		.replace(/^focus (?:the )?satire (?:on|toward)\s+/i, '')
		.replace(/^direct (?:the )?satire (?:at|toward)\s+/i, '')
		.trim();
}

export function produceArticleImagePrompt(
	story: EditorialStory,
	governance?: ArticleImagePromptGovernance,
): ArticleImagePrompt {
	const premise = cleanConcept(story.headline);
	if (!premise || isInternalEditorialText(premise)) {
		throw new Error('The story does not contain a reader-facing image premise.');
	}
	const governedSensitiveSource = governance?.satireSuitability === 'SENSITIVE'
		|| governance?.guardrailFlags.includes('UNRESOLVED_ALLEGATION');
	const supportingConcept = [story.deck, story.socialExcerpt, story.bodyMarkdown]
		.map(cleanConcept)
		.find((value) => value.length > 0 && !isInternalEditorialText(value));
	const cautionDirection = governedSensitiveSource
		? approvedVisualDirection(governance?.editorialCautionDirection ?? '')
		: '';
	if (governedSensitiveSource && !cautionDirection) {
		throw new Error('A sensitive story requires an approved visual caution direction.');
	}
	const mechanism = cleanConcept(governance?.satiricalMechanism ?? '');
	const centralConcept = governedSensitiveSource
		? `An anonymous, mannequin-like editorial scene centered on ${lowerFirst(cautionDirection)}, in a generic setting appropriate to that direction`
		: supportingConcept
			?? `A literal visual interpretation of ${lowerFirst(premise)}, staged in a recognizable ${story.category.name.toLowerCase()} setting with subtle satirical details`;
	const altConcept = governedSensitiveSource ? cautionDirection : supportingConcept ?? lowerFirst(premise);
	const prompt = [
		ARTICLE_IMAGE_HOUSE_DIRECTION,
		`Create an original editorial illustration for the ${story.category.name} section.`,
		`Central visual concept: ${centralConcept}.`,
		`Satirical premise: ${premise}.`,
		...(governedSensitiveSource ? [
			...(mechanism ? [`Use the persisted satirical mechanism: ${mechanism}.`] : []),
			'Governed visual boundary: use only anonymous, mannequin-like, or symbolic subjects in a generic environment; keep every subject fully and conventionally clothed.',
			'Omit real-person likenesses and any depiction of the reported event or law-enforcement activity; source facts are background context only and must not determine the focal subject.',
		] : []),
		'Treat the scene as clearly illustrative rather than documentary photographic evidence of a real event.',
		'Landscape composition, 16:9, with a clear focal subject and room for responsive crops.',
	].join(' ');

	return {
		prompt,
		proposedAltText: `Editorial illustration of ${lowerFirst(altConcept)}.`,
		promptVersion: ARTICLE_IMAGE_PROMPT_VERSION,
	};
}
