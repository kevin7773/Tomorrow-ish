import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('article image persistence governance', () => {
	const migration = readFileSync(join(process.cwd(), 'migrations/0005_governed_article_images.sql'), 'utf8');
	const repository = readFileSync(join(process.cwd(), 'src/data/d1-article-image-repository.ts'), 'utf8');

	it('preserves immutable generation history and requires alt text on approval', () => {
		expect(migration).toContain('CREATE TRIGGER article_images_no_delete');
		expect(migration).toContain("status <> 'APPROVED'");
		expect(migration).toContain('article_images_provenance_immutable');
		expect(repository).not.toMatch(/DELETE FROM article_images/i);
	});

	it('creates generated records unapproved and associates only explicit approvals to the story', () => {
		expect(repository).toContain("'GENERATED'");
		expect(repository).toMatch(/UPDATE stories SET og_image_key/s);
		expect(repository).toMatch(/status = 'APPROVED'/);
		expect(repository).toMatch(/NOT EXISTS \(SELECT 1 FROM stories WHERE id = \? AND og_image_key = article_images\.asset_key\)/);
	});

	it('keeps providers and image services outside publication authority', () => {
		for (const file of [
			'src/images/image-provider.ts',
			'src/images/replicate-flux-provider.ts',
			'src/services/article-image-service.ts',
			'src/data/d1-article-image-repository.ts',
		]) {
			const source = readFileSync(join(process.cwd(), file), 'utf8');
			expect(source, file).not.toMatch(/publishStory|publishApprovedStory|publication-service/);
		}
	});

	it('serves public image bytes only for a PUBLISHED story association', () => {
		const route = readFileSync(join(process.cwd(), 'src/pages/media/[...key].ts'), 'utf8');
		expect(route).toMatch(/status = 'PUBLISHED'/);
		expect(route).toMatch(/og_image_key = \?/);
	});
});
