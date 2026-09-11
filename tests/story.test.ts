import { describe, expect, it } from 'vitest';
import type { Story } from '../src/domain/story';
import { groupStoriesByEdition, storyParagraphs } from '../src/domain/story';

function story(id: string, editionDate: string): Story {
	return {
		id,
		slug: id,
		headline: `Headline ${id}`,
		deck: 'A fictional deck.',
		bodyMarkdown: 'One paragraph.',
		editionDate,
		publishedAt: `${editionDate}T12:00:00Z`,
		category: { id: 'category', slug: 'category', name: 'Category' },
		status: 'PUBLISHED',
		socialExcerpt: 'Fictional sample.',
		ogImageKey: null,
		imageAltText: null,
		tags: [],
		sources: [],
	};
}

describe('story presentation helpers', () => {
	it('groups ordered stories into ordered editions', () => {
		const editions = groupStoriesByEdition([
			story('a', '2026-09-11'),
			story('b', '2026-09-10'),
			story('c', '2026-09-10'),
		]);

		expect(editions.map((edition) => edition.editionDate)).toEqual(['2026-09-11', '2026-09-10']);
		expect(editions[1]?.stories.map(({ id }) => id)).toEqual(['b', 'c']);
	});

	it('turns plain editorial paragraphs into safe text blocks', () => {
		expect(storyParagraphs('First line\ncontinues.\n\nSecond paragraph.')).toEqual([
			'First line continues.',
			'Second paragraph.',
		]);
	});
});
