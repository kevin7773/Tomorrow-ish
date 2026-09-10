import { describe, expect, it } from 'vitest';
import { D1EditorialRepository } from '../src/data/d1-editorial-repository';

interface RecordedStatement {
	query: string;
	bindings: unknown[];
}

function recordingDatabase(batches: RecordedStatement[][]): D1Database {
	return {
		prepare(query: string) {
			const statement: RecordedStatement & { bind: (...values: unknown[]) => typeof statement } = {
				query,
				bindings: [],
				bind(...values: unknown[]) {
					statement.bindings = values;
					return statement;
				},
			};
			return statement as unknown as D1PreparedStatement;
		},
		async batch(statements: D1PreparedStatement[]) {
			batches.push(statements as unknown as RecordedStatement[]);
			return statements.map(() => ({ success: true, meta: { changes: 1 }, results: [] }));
		},
	} as unknown as D1Database;
}

describe('D1 publication authority SQL', () => {
	it('publishes and audits in one batch owned by the explicit repository method', async () => {
		const batches: RecordedStatement[][] = [];
		const repository = new D1EditorialRepository(recordingDatabase(batches));
		await repository.publishApprovedStory({
			id: 'story-1',
			actorEmail: 'newsgoblin@tomorrow-ish.news',
			publishedAt: '2026-09-10T14:00:00.000Z',
			auditId: 'audit-publish',
		});
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(2);
		expect(batches[0][0].query).toMatch(/'STORY'.*'PUBLISHED'/s);
		expect(batches[0][0].query).toMatch(/status = 'APPROVED'/);
		expect(batches[0][1].query).toMatch(/SET status = 'PUBLISHED', published_at = \?/);
		expect(batches[0][1].query).toMatch(/status = 'APPROVED'/);
	});

	it('uses a literal DRAFT status for candidate conversion', async () => {
		const batches: RecordedStatement[][] = [];
		const repository = new D1EditorialRepository(recordingDatabase(batches));
		await repository.convertApprovedCandidateToDraft({
			candidateId: 'candidate-1',
			storyId: 'story-1',
			slug: 'story-one',
			editionDate: '2026-09-11',
			socialExcerpt: 'Fictional.',
			actorEmail: 'newsgoblin@tomorrow-ish.news',
			createdAt: '2026-09-10T14:00:00.000Z',
			auditIds: ['audit-candidate', 'audit-story'],
		});
		expect(batches[0][0].query).toContain("'DRAFT'");
		expect(batches[0][0].query).not.toContain("'PUBLISHED'");
	});

	it('adds a runtime guard against PUBLISHED in generic transition SQL', async () => {
		const batches: RecordedStatement[][] = [];
		const repository = new D1EditorialRepository(recordingDatabase(batches));
		await repository.transitionStory({
			id: 'story-1',
			from: 'REVIEW',
			to: 'APPROVED',
			actorEmail: 'newsgoblin@tomorrow-ish.news',
			updatedAt: '2026-09-10T14:00:00.000Z',
			auditId: 'audit-1',
		});
		expect(batches[0][0].query).toContain("? <> 'PUBLISHED'");
	});
});
