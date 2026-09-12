import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('source provenance persistence', () => {
	it('snapshots intake source references during candidate conversion', async () => {
		const batches: RecordedStatement[][] = [];
		const repository = new D1EditorialRepository(recordingDatabase(batches));
		await repository.convertApprovedCandidateToDraft({
			candidateId: 'candidate-1',
			storyId: 'story-1',
			slug: 'story-one',
			editionDate: '2026-09-12',
			socialExcerpt: 'Fictional.',
			actorEmail: 'newsgoblin@tomorrow-ish.news',
			createdAt: '2026-09-12T14:00:00.000Z',
			auditIds: ['audit-candidate', 'audit-story'],
		});

		expect(batches[0][1].query).toMatch(/INSERT INTO sources/);
		expect(batches[0][1].query).toMatch(/JOIN source_references AS reference/);
		expect(batches[0][1].query).toMatch(/reference\.source_intake_id = candidate\.source_intake_id/);
		expect(batches[0][1].query).toContain("story.status = 'DRAFT'");
	});

	it('backfills source snapshots for already-converted stories idempotently', () => {
		const migration = readFileSync(
			join(process.cwd(), 'migrations/0011_backfill_candidate_story_sources.sql'),
			'utf8',
		);
		expect(migration).toMatch(/INSERT INTO sources/);
		expect(migration).toMatch(/story\.origin_candidate_id/);
		expect(migration).toMatch(/reference\.source_intake_id = candidate\.source_intake_id/);
		expect(migration).toMatch(/WHERE NOT EXISTS/);
	});
});
