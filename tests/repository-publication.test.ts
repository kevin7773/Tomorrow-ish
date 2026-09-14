import { describe, expect, it } from 'vitest';
import { D1StoryRepository } from '../src/data/d1-story-repository';

function recordingDatabase(queries: string[]): D1Database {
	const statement = {
		bind() {
			return statement;
		},
		async first() {
			return null;
		},
		async all() {
			return { results: [] };
		},
	};

	return {
		prepare(query: string) {
			queries.push(query);
			return statement;
		},
	} as unknown as D1Database;
}

function storyDatabase(queries: string[], publishedAt: string, editionDate: string): D1Database {
	const row = {
		id: 'published-story', slug: 'published-story', headline: 'Published story', deck: 'Deck',
		body_markdown: 'Body.', edition_date: editionDate, published_at: publishedAt,
		category_id: 'category', category_slug: 'category', category_name: 'Category', status: 'PUBLISHED',
		social_excerpt: 'Excerpt.', og_image_key: null, image_alt_text: null, tags_json: '[]',
	};
	const statement = {
		bind() { return statement; },
		async first() { return row; },
		async all() { return { results: [row] }; },
	};
	return {
		prepare(query: string) {
			queries.push(query);
			return statement;
		},
	} as unknown as D1Database;
}

describe('public story repository', () => {
	it('applies the PUBLISHED boundary to every public story query', async () => {
		const queries: string[] = [];
		const repository = new D1StoryRepository(recordingDatabase(queries));

		await repository.findPublishedBySlug('hidden-story');
		await repository.getLeadStory();
		await repository.listPublished();
		await repository.listPublished({ excludeId: 'published-story' });

		expect(queries).toHaveLength(4);
		for (const query of queries) {
			expect(query).toMatch(/s\.status\s*=\s*'PUBLISHED'/);
		}
	});

	it('derives homepage and Latest edition days from the Eastern publication date', async () => {
		const queries: string[] = [];
		const repository = new D1StoryRepository(storyDatabase(
			queries,
			'2026-09-15T01:30:00Z',
			'2026-09-15',
		));

		const leadStory = await repository.getLeadStory();
		const latestStories = await repository.listPublished();

		expect(leadStory?.editionDate).toBe('2026-09-14');
		expect(latestStories[0]?.editionDate).toBe('2026-09-14');
		for (const query of queries) {
			expect(query).toMatch(/ORDER BY s\.published_at DESC, s\.id DESC/);
			expect(query).not.toMatch(/ORDER BY s\.edition_date/);
		}
	});
});
