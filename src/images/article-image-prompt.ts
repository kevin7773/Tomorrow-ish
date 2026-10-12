import type { EditorialStory, SatireSuitability } from '../domain/editorial';
import type { GuardrailFlag } from '../domain/generation';

export const ARTICLE_IMAGE_PROMPT_VERSION = 'tomorrow-ish-editorial-v4';
export const ARTICLE_IMAGE_HOUSE_DIRECTION =
	'Editorial news illustration, subtly absurd but visually plausible, polished magazine/news-site quality, strong composition, slightly cinematic, no embedded text, no logos, no watermarks.';
export const IMAGE_VISUAL_DIRECTION_MAX_LENGTH = 600;
export const BELICHICK_SMOKE_VISUAL_DIRECTION =
	'A fictional ranking-review bureau inside a generic football operations office, where anonymous mannequin-like clerks in unbranded neutral clothing examine an oversized abstract ranking token and stacks of blank paperwork using magnifying glasses and unmarked stamp tools.';
export const SMOKE_IMAGE_MANDATORY_CONSTRAINTS =
	'Depict a fictional scene only. Do not depict Bill Belichick or any other recognizable real person. Do not use team colors, uniforms, mascots, logos, trademarks, jersey numbers, stadium branding, readable words, letters, numerals, forms, signs, screens, captions, or watermarks; all papers and display surfaces must be blank or abstract.';

const PROTECTED_PERIOD = '\uE000';

function cleanText(value: string): string {
	return value
		.replace(/[#*_>`~\[\]()]/g, ' ')
		.replace(/https?:\/\/\S+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function cleanConcept(value: string): string {
	const cleaned = cleanText(value)
		.replace(/\b(No|Dr|Mr|Mrs|Ms|Prof|St)\.(?=\s+[A-Z0-9])/g, `$1${PROTECTED_PERIOD}`)
		.replace(/\b(?:[A-Z]\.\s+)+(?=[A-Z])/g, (initials) => initials.replaceAll('.', PROTECTED_PERIOD));
	return cleaned
		.split(/(?<=[.!?])\s+/)[0]
		.replaceAll(PROTECTED_PERIOD, '.')
		.slice(0, 280)
		.replace(/[,:;\s]+$/, '');
}

export function validateImageVisualDirection(value: string): string {
	const normalized = cleanText(value);
	if (!normalized || normalized.length < 20 || normalized.length > IMAGE_VISUAL_DIRECTION_MAX_LENGTH) {
		throw new Error(`Visual direction must be between 20 and ${IMAGE_VISUAL_DIRECTION_MAX_LENGTH} characters.`);
	}
	if (/https?:\/\//i.test(normalized)
		|| /\b(?:ignore|override|disregard|bypass|replace)\b.{0,80}\b(?:instruction|constraint|prompt|rule)\b/i.test(normalized)
		|| /\b(?:model|provider|quality|size|aspect\s*ratio|output\s*format|webhook)\s*[:=]/i.test(normalized)
		|| /\b(?:set|change|use)\s+(?:the\s+)?(?:model|provider|quality|size|aspect\s*ratio|output\s*format)\b/i.test(normalized)
		|| /\b(?:gpt-image|openai|cloudflare|webp|png|jpe?g)\b|\b\d{3,4}\s*[x×]\s*\d{3,4}\b|\b(?:16:9|3:2)\b/i.test(normalized)
		|| /\b(?:bill belichick|logo|trademark|readable text|caption|lettering|real person|likeness|team colors?|uniforms?|mascots?|jersey numbers?|stadium branding)\b/i.test(normalized)) {
		throw new Error('Visual direction conflicts with mandatory image-generation constraints.');
	}
	return normalized;
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
	visualDirection?: string,
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
	const governedDirection = visualDirection === undefined ? '' : validateImageVisualDirection(visualDirection);
	const centralConcept = governedDirection || (governedSensitiveSource
		? `An anonymous, mannequin-like editorial scene centered on ${lowerFirst(cautionDirection)}, in a generic setting appropriate to that direction`
		: supportingConcept
			?? `A literal visual interpretation of ${lowerFirst(premise)}, staged in a recognizable ${story.category.name.toLowerCase()} setting with subtle satirical details`);
	const altConcept = governedDirection ? cleanConcept(governedDirection) : governedSensitiveSource ? cautionDirection : supportingConcept ?? premise;
	const prompt = [
		ARTICLE_IMAGE_HOUSE_DIRECTION,
		`Create an original editorial illustration for the ${story.category.name} section.`,
		`Central visual concept: ${centralConcept}.`,
		`Satirical premise: ${premise}.`,
		...(governedDirection ? [SMOKE_IMAGE_MANDATORY_CONSTRAINTS] : []),
		...(governedSensitiveSource ? [
			...(mechanism ? [`Use the persisted satirical mechanism: ${mechanism}.`] : []),
			'Governed visual boundary: use only anonymous, mannequin-like, or symbolic subjects in a generic environment; keep every subject fully and conventionally clothed.',
			'Omit real-person likenesses and any depiction of the reported event or law-enforcement activity; source facts are background context only and must not determine the focal subject.',
		] : []),
		'Treat the scene as clearly illustrative rather than documentary photographic evidence of a real event.',
		'Landscape composition, 3:2, with a clear focal subject and room for responsive crops.',
	].join(' ');

	return {
		prompt,
		proposedAltText: `Editorial illustration of ${altConcept}.`,
		promptVersion: ARTICLE_IMAGE_PROMPT_VERSION,
	};
}
