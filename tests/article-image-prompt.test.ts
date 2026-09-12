import { describe, expect, it } from 'vitest';
import type { EditorialStory } from '../src/domain/editorial';
import { ARTICLE_IMAGE_PROMPT_VERSION, produceArticleImagePrompt } from '../src/images/article-image-prompt';

function story(overrides: Partial<EditorialStory> = {}): EditorialStory {
	return {
		id: 'story-1',
		slug: 'office-plant-cleared-for-middle-management',
		headline: 'Office Plant Cleared for Middle Management',
		deck: 'A fictional approved item that must never appear before publication.',
		bodyMarkdown: 'This approved but unpublished item exists only to verify the public boundary.',
		editionDate: '2026-09-12',
		publishedAt: null,
		category: { id: 'business', slug: 'business', name: 'Business' },
		status: 'APPROVED',
		socialExcerpt: 'Unpublished fictional test content.',
		tags: [],
		ogImageKey: null,
		originCandidateId: null,
		updatedAt: '2026-09-11T12:00:00.000Z',
		...overrides,
	};
}

describe('article image prompt', () => {
	it('derives the visual concept from the headline when supporting fields contain internal scaffolding', () => {
		const result = produceArticleImagePrompt(story());

		expect(result.promptVersion).toBe(ARTICLE_IMAGE_PROMPT_VERSION);
		expect(result.prompt).toContain(
			'Central visual concept: A literal visual interpretation of office Plant Cleared for Middle Management, staged in a recognizable business setting with subtle satirical details.',
		);
		expect(result.prompt).not.toMatch(/approved item|unpublished|must never appear|before publication|test content|public boundary/i);
		expect(result.proposedAltText).toBe('Editorial illustration of office Plant Cleared for Middle Management.');
	});

	it('uses reader-facing story detail when it contains a concrete visual scene', () => {
		const result = produceArticleImagePrompt(story({
			headline: 'Agency Forms Task Force to Review Task Forces',
			deck: 'Officials gather around an absurdly long conference table to review their own review process.',
			socialExcerpt: 'A fictional task force convenes.',
			bodyMarkdown: 'Officials convened in a municipal conference room.',
		}));

		expect(result.prompt).toContain(
			'Central visual concept: Officials gather around an absurdly long conference table to review their own review process.',
		);
	});

	it('refuses an internal-only headline instead of sending it as a visual concept', () => {
		expect(() => produceArticleImagePrompt(story({
			headline: 'M2 Production Validation Candidate — Do Not Publish',
		}))).toThrow('reader-facing image premise');
	});

	it('uses persisted sensitive-source direction instead of allegation details', () => {
		const result = produceArticleImagePrompt(story({
			headline: 'Local Man’s Reported Outfit Raises Questions About Whether Sneakers Are Ever Enough',
			deck: 'Authorities said they arrested a 41-year-old man after responding to an alleged indecent-exposure incident at a Target parking lot.',
			bodyMarkdown: 'The report said the accused person was wearing only a G-string and sneakers.',
			socialExcerpt: 'A Florida arrest report described alleged conduct in a retail parking lot.',
		}), {
			satireSuitability: 'SENSITIVE',
			guardrailFlags: ['UNRESOLVED_ALLEGATION'],
			editorialCautionDirection: 'Focus satire on hypothetical retail dress-code / parking-lot policy, not on the accused person or unresolved allegations.',
			satiricalMechanism: 'Treating a basic social norm as a narrowly contested policy question.',
		});

		expect(result.prompt).toContain('Central visual concept: An anonymous, mannequin-like editorial scene centered on hypothetical retail dress-code / parking-lot policy');
		expect(result.prompt).toContain('Use the persisted satirical mechanism: Treating a basic social norm as a narrowly contested policy question.');
		expect(result.prompt).toContain('source facts are background context only');
		expect(result.prompt).toContain('keep every subject fully and conventionally clothed');
		expect(result.prompt).not.toMatch(/41-year-old|indecent|G-string|sex toys|Target|arrested|accused person/i);
		expect(result.prompt).not.toMatch(/nudity|sexualized|re-?enact(?:ment)?/i);
		expect(result.proposedAltText).toBe('Editorial illustration of hypothetical retail dress-code / parking-lot policy.');
	});

	it('fails closed when sensitive-source caution direction is absent', () => {
		expect(() => produceArticleImagePrompt(story(), {
			satireSuitability: 'SENSITIVE',
			guardrailFlags: ['UNRESOLVED_ALLEGATION'],
			editorialCautionDirection: ' ',
			satiricalMechanism: 'Policy extrapolation.',
		})).toThrow('approved visual caution direction');
	});

	it('uses the positive persisted direction when caution begins with an exclusion', () => {
		const result = produceArticleImagePrompt(story(), {
			satireSuitability: 'SENSITIVE',
			guardrailFlags: ['UNRESOLVED_ALLEGATION'],
			editorialCautionDirection: 'Avoid depicting the accused person. Focus satire on an anonymous retail policy display, not the reported event.',
			satiricalMechanism: 'Policy extrapolation.',
		});

		expect(result.prompt).toContain('centered on an anonymous retail policy display');
		expect(result.prompt.match(/Central visual concept:[^.]+\./)?.[0]).not.toMatch(/accused person|reported event/i);
	});

	it('keeps the ordinary non-sensitive prompt text unchanged', () => {
		const ordinaryStory = story({
			headline: 'Agency Forms Task Force to Review Task Forces',
			deck: 'Officials gather around an absurdly long conference table to review their own review process.',
			socialExcerpt: 'A fictional task force convenes.',
			bodyMarkdown: 'Officials convened in a municipal conference room.',
		});
		const withoutGovernance = produceArticleImagePrompt(ordinaryStory);
		const withGovernance = produceArticleImagePrompt(ordinaryStory, {
			satireSuitability: 'SUITABLE', guardrailFlags: [], editorialCautionDirection: '',
			satiricalMechanism: 'Bureaucratic extrapolation.',
		});

		expect(withGovernance.prompt).toBe(withoutGovernance.prompt);
		expect(withGovernance.proposedAltText).toBe(withoutGovernance.proposedAltText);
	});
});
