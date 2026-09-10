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
});
