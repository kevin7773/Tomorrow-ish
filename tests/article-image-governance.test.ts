import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCurrentHeroImage } from '../src/domain/article-image';
import { isImageGenerationEnabled } from '../src/images/image-provider-factory';

describe('article image persistence governance', () => {
	const migration = readFileSync(join(process.cwd(), 'migrations/0005_governed_article_images.sql'), 'utf8');
	const asyncMigration = readFileSync(join(process.cwd(), 'migrations/0007_async_article_images.sql'), 'utf8');
	const repository = readFileSync(join(process.cwd(), 'src/data/d1-article-image-repository.ts'), 'utf8');

	it('preserves immutable generation history and requires alt text on approval', () => {
		expect(migration).toContain('CREATE TRIGGER article_images_no_delete');
		expect(migration).toContain("status <> 'APPROVED'");
		expect(migration).toContain('article_images_provenance_immutable');
		expect(repository).not.toMatch(/DELETE FROM article_images/i);
	});

	it('adds one explicit pending request per story without rewriting historical rows', () => {
		expect(asyncMigration).toContain("'PENDING'");
		expect(asyncMigration).toMatch(/CREATE UNIQUE INDEX idx_article_images_one_pending_per_story[\s\S]*WHERE status = 'PENDING'/);
		expect(asyncMigration).toMatch(/INSERT INTO article_images[\s\S]*FROM article_images_legacy/);
		expect(asyncMigration).toContain('CREATE TABLE article_image_webhook_inbox');
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
			'src/images/openai-image-provider.ts',
			'src/images/cloudflare-gateway-image-provider.ts',
			'src/services/article-image-service.ts',
			'src/services/async-article-image-service.ts',
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

	it('keeps pending state visible and non-reviewable in the editorial UI', () => {
		const page = readFileSync(join(process.cwd(), 'src/pages/editorial/stories/[id].astro'), 'utf8');
		expect(page).toContain("image.status === 'PENDING'");
		expect(page).toContain('disabled={!imageGenerationEnabled || hasPendingImage}');
		expect(page).toMatch(/image\.status === 'GENERATED'[\s\S]*Approve and attach image/);
		expect(page).not.toMatch(/image\.status === 'PENDING'[\s\S]{0,300}Approve and attach image/);
	});

	it('reflects the server image-generation flag in the editorial control', () => {
		const page = readFileSync(join(process.cwd(), 'src/pages/editorial/stories/[id].astro'), 'utf8');
		expect(isImageGenerationEnabled({})).toBe(false);
		expect(isImageGenerationEnabled({ IMAGE_GENERATION_ENABLED: 'false' })).toBe(false);
		expect(isImageGenerationEnabled({ IMAGE_GENERATION_ENABLED: 'true' })).toBe(true);
		expect(page).toContain('disabled={!imageGenerationEnabled || hasPendingImage}');
		expect(page).toContain("!imageGenerationEnabled ? 'Image generation disabled'");
		expect(page).toContain('Image generation is currently disabled.');
	});

	it('labels only matching non-null image assets as the current hero', () => {
		expect(isCurrentHeroImage(null, null)).toBe(false);
		expect(isCurrentHeroImage(null, 'images/story/image.webp')).toBe(false);
		expect(isCurrentHeroImage('images/story/image.webp', null)).toBe(false);
		expect(isCurrentHeroImage('images/story/image.webp', 'images/story/other.webp')).toBe(false);
		expect(isCurrentHeroImage('images/story/image.webp', 'images/story/image.webp')).toBe(true);
	});

	it('authenticates the bounded webhook before parsing or processing its body', () => {
		const route = readFileSync(join(process.cwd(), 'src/pages/api/image-generation/webhook/[imageId].ts'), 'utf8');
		const auth = route.indexOf('verifyImageWebhookSignature');
		const body = route.indexOf('readCloudflareImageWebhookRequest(request)');
		expect(auth).toBeGreaterThan(-1);
		expect(body).toBeGreaterThan(auth);
		expect(route).not.toContain('request.text()');
	});
});
