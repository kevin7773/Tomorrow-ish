import { describe, expect, it } from 'vitest';
import type { Story } from '../src/domain/story';
import { groupStoriesByEdition, storyParagraphs, storySourceLabel } from '../src/domain/story';

function story(id: string, editionDate: string, publishedAt = `${editionDate}T12:00:00Z`): Story {
	return {
		id,
		slug: id,
		headline: `Headline ${id}`,
		deck: 'A fictional deck.',
		bodyMarkdown: 'One paragraph.',
		editionDate,
		publishedAt,
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

	it('groups the archive by the Eastern publication date instead of the stored edition date', () => {
		const editions = groupStoriesByEdition([
			story('after-utc-midnight', '2026-09-15', '2026-09-15T01:30:00Z'),
			story('same-eastern-day', '2026-09-14', '2026-09-14T16:00:00Z'),
		]);

		expect(editions).toHaveLength(1);
		expect(editions[0]?.editionDate).toBe('2026-09-14');
		expect(editions[0]?.stories.map(({ editionDate }) => editionDate)).toEqual([
			'2026-09-14',
			'2026-09-14',
		]);
	});

	it('turns plain editorial paragraphs into safe text blocks', () => {
		expect(storyParagraphs('First line\ncontinues.\n\nSecond paragraph.')).toEqual([
			'First line continues.',
			'Second paragraph.',
		]);
	});

	it('labels sourced stories with publisher and source headline', () => {
		expect(storySourceLabel({
			id: 'source-1', title: 'Target changes self-checkout policy',
			url: 'https://news.example.test/target', publisher: 'Regional Newsroom', publishedAt: null,
		})).toBe('Regional Newsroom: Target changes self-checkout policy');
	});

	it('uses a neutral linked-source label when optional attribution is missing', () => {
		expect(storySourceLabel({
			id: 'source-2', title: ' ', url: 'https://news.example.test/report',
			publisher: null, publishedAt: null,
		})).toBe('Original source article');
	});
});
