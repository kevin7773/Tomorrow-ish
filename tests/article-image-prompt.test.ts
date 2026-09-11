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
});
