import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EditorialRepository } from '../src/data/editorial-repository';
import { D1StoryRepository } from '../src/data/d1-story-repository';
import { EditorialService } from '../src/services/editorial-service';

const root = process.cwd();
const newCategories = [
	{ id: 'cat-sports', slug: 'sports', name: 'Sports' },
	{ id: 'cat-weather', slug: 'weather', name: 'Weather' },
	{ id: 'cat-community', slug: 'community', name: 'Community' },
] as const;

interface RecordedStatement {
	query: string;
	bindings: unknown[];
}

function recordingDatabase(statements: RecordedStatement[]): D1Database {
	return {
		prepare(query: string) {
			const record: RecordedStatement = { query, bindings: [] };
			statements.push(record);
			const statement = {
				bind(...values: unknown[]) {
					record.bindings = values;
					return statement;
				},
				async first() {
					return null;
				},
				async all() {
					return { results: [] };
				},
			};
			return statement;
		},
	} as unknown as D1Database;
}

describe('first-class category taxonomy', () => {
	it('adds the three canonical rows idempotently without changing existing rows', () => {
		const migration = readFileSync(join(root, 'migrations/0006_add_editorial_categories.sql'), 'utf8');
		const seed = readFileSync(join(root, 'seed.sql'), 'utf8');
		expect(migration).toContain('INSERT OR IGNORE INTO categories');
		expect(migration).not.toMatch(/UPDATE\s+categories|DELETE\s+FROM\s+categories/i);
		for (const category of newCategories) {
			const row = `('${category.id}', '${category.slug}', '${category.name}'`;
			expect(migration).toContain(row);
			expect(seed).toContain(row);
		}
		for (const existing of ['cat-civic-life', 'cat-science', 'cat-business', 'cat-florida-probably']) {
			expect(seed).toContain(existing);
		}
	});

	it.each(newCategories)('filters published stories for $name using the canonical slug', async ({ slug }) => {
		const statements: RecordedStatement[] = [];
		const repository = new D1StoryRepository(recordingDatabase(statements));
		await repository.listPublished({ categorySlug: slug, limit: 25 });
		expect(statements).toHaveLength(1);
		expect(statements[0].query).toMatch(/s\.status = 'PUBLISHED'/);
		expect(statements[0].query).toMatch(/c\.slug = \?/);
		expect(statements[0].bindings).toEqual([slug, 25]);
	});

	it('resolves categories by slug and leaves unknown slugs unresolved', async () => {
		const statements: RecordedStatement[] = [];
		const repository = new D1StoryRepository(recordingDatabase(statements));
		await expect(repository.findCategoryBySlug('unknown')).resolves.toBeNull();
		expect(statements[0].query).toMatch(/FROM categories WHERE slug = \?/);
		expect(statements[0].bindings).toEqual(['unknown']);
	});

	it.each(newCategories)('accepts $name in the editorial candidate workflow', async ({ id }) => {
		const createCandidate = vi.fn().mockResolvedValue(true);
		const repository = {
			categoryExists: vi.fn(async (categoryId: string) => categoryId === id),
			createCandidate,
		} as unknown as EditorialRepository;
		const service = new EditorialService(repository, {
			now: () => '2026-09-11T17:00:00Z',
			createId: () => 'generated-id',
		});

		await expect(service.createCandidate({ email: 'editor@example.com' }, {
			sourceIntakeId: 'intake-1',
			proposedHeadline: 'Tomorrow arrives on schedule',
			proposedDeck: 'A valid fictional deck',
			draftBodyMarkdown: 'A complete fictional draft body.',
			categoryId: id,
		})).resolves.toBe('generated-id');
		expect(createCandidate).toHaveBeenCalledWith(expect.objectContaining({ categoryId: id }));
	});

	it('rejects an unknown editorial category before persistence', async () => {
		const createCandidate = vi.fn();
		const repository = {
			categoryExists: vi.fn().mockResolvedValue(false),
			createCandidate,
		} as unknown as EditorialRepository;
		const service = new EditorialService(repository);

		await expect(service.createCandidate({ email: 'editor@example.com' }, {
			sourceIntakeId: 'intake-1',
			proposedHeadline: 'Tomorrow arrives on schedule',
			proposedDeck: 'A valid fictional deck',
			draftBodyMarkdown: 'A complete fictional draft body.',
			categoryId: 'cat-unknown',
		})).rejects.toThrow('Category is invalid.');
		expect(createCandidate).not.toHaveBeenCalled();
	});

	it('keeps editorial forms table-driven and exposes public category routes', () => {
		for (const file of [
			'src/pages/editorial/intakes/[id]/candidates/new.astro',
			'src/pages/editorial/intakes/[id]/generate.astro',
			'src/pages/editorial/candidates/[id].astro',
			'src/pages/editorial/stories/[id].astro',
		]) {
			const source = readFileSync(join(root, file), 'utf8');
			expect(source, file).toContain('listCategories()');
			expect(source, file).toMatch(/categories\.map/);
		}
		const categoryRoute = readFileSync(join(root, 'src/pages/category/[slug].astro'), 'utf8');
		expect(categoryRoute).toContain('findCategoryBySlug');
		expect(categoryRoute).toContain('categorySlug: category.slug');
		const sitemap = readFileSync(join(root, 'src/pages/sitemap.xml.ts'), 'utf8');
		expect(sitemap).toContain('/category/${category.slug}');
	});
});
