import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCurrentHeroImage } from '../src/domain/article-image';
import { isImageGenerationEnabled } from '../src/images/image-provider-factory';

describe('article image persistence governance', () => {
	const migration = readFileSync(join(process.cwd(), 'migrations/0005_governed_article_images.sql'), 'utf8');
	const asyncMigration = readFileSync(join(process.cwd(), 'migrations/0007_async_article_images.sql'), 'utf8');
	const webhookRetentionMigration = readFileSync(join(process.cwd(), 'migrations/0008_scrub_image_webhook_result_urls.sql'), 'utf8');
	const reservationMigration = readFileSync(join(process.cwd(), 'migrations/0019_image_request_reservations.sql'), 'utf8');
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
		expect(webhookRetentionMigration).toContain("CASE WHEN processing_state = 'PROCESSED' THEN NULL ELSE result_url END");
		expect(webhookRetentionMigration).toContain("processing_state = 'PROCESSED' AND result_url IS NULL");
	});

	it('persists immutable attempt identity, ambiguity, and separate cost evidence', () => {
		expect(reservationMigration).toContain('attempt_key TEXT');
		expect(reservationMigration).toContain("'AMBIGUOUS'");
		expect(reservationMigration).toContain('CREATE UNIQUE INDEX idx_article_images_attempt_key');
		expect(reservationMigration).toContain('estimated_cost_microusd');
		expect(reservationMigration).toContain('provider_reported_usage_json');
		expect(reservationMigration).toContain('verified_billed_cost_microusd');
		expect(reservationMigration).toContain('article_images_attempt_identity_immutable');
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
		expect(page).toContain('disabled={!imageGenerationEnabled || hasPendingImage || !imageAttemptHistoryReady || !promptWasExplicitlyReviewed}');
		expect(page).toMatch(/image\.status === 'GENERATED'[\s\S]*Approve and attach image/);
		expect(page).not.toMatch(/image\.status === 'PENDING'[\s\S]{0,300}Approve and attach image/);
	});

	it('reflects the server image-generation flag in the editorial control', () => {
		const page = readFileSync(join(process.cwd(), 'src/pages/editorial/stories/[id].astro'), 'utf8');
		expect(isImageGenerationEnabled({})).toBe(false);
		expect(isImageGenerationEnabled({ IMAGE_GENERATION_ENABLED: 'false' })).toBe(false);
		expect(isImageGenerationEnabled({ IMAGE_GENERATION_ENABLED: 'true' })).toBe(true);
		expect(page).toContain('disabled={!imageGenerationEnabled || hasPendingImage || !imageAttemptHistoryReady || !promptWasExplicitlyReviewed}');
		expect(page).toContain("!imageGenerationEnabled ? 'Image generation disabled'");
		expect(page).toContain('Image generation is currently disabled.');
		expect(page).toContain('Explicit visual direction');
		expect(page).toContain('Final assembled provider prompt');
	});

	it('validates direction and regeneration history before constructing a paid provider', () => {
		const route = readFileSync(join(process.cwd(), 'src/pages/editorial/actions/images.ts'), 'utf8');
		const action = route.indexOf("if (action === 'generate')");
		const authentication = route.indexOf('requireEditor(context)');
		const direction = route.indexOf('governedImageVisualDirection', action);
		const history = route.indexOf('assertImageAttemptHistoryAllowsSubmission', action);
		const provider = route.indexOf('getImageProvider()', action);
		expect(authentication).toBeGreaterThan(-1);
		expect(authentication).toBeLessThan(action);
		expect(direction).toBeGreaterThan(-1);
		expect(history).toBeGreaterThan(direction);
		expect(provider).toBeGreaterThan(history);
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
