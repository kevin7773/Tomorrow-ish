import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1ArticleImageRepository } from '../src/data/d1-article-image-repository';
import type { EditorialRepository } from '../src/data/editorial-repository';
import type { ImageProvider } from '../src/images/image-provider';
import { ArticleImageService } from '../src/services/article-image-service';

const NOW = '2026-10-12T15:00:00.000Z';
const execute = Symbol('execute');
type Executable = D1PreparedStatement & { [execute]: () => D1Result };

function d1(sqlite: DatabaseSync): D1Database {
	return { prepare(query: string) { let values: unknown[] = []; const statement = {
		bind(...bindings: unknown[]) { values = bindings; return statement; },
		async first<T>() { return (sqlite.prepare(query).get(...values as never[]) as T | undefined) ?? null; },
		async all<T>() { return { success: true, results: sqlite.prepare(query).all(...values as never[]) as T[] } as D1Result<T>; },
		async run<T>() { return statement[execute]() as D1Result<T>; },
		[execute]() { const result = sqlite.prepare(query).run(...values as never[]); return {
			success: true, results: [], meta: { changes: Number(result.changes) },
		} as unknown as D1Result; },
	}; return statement as unknown as D1PreparedStatement; },
	async batch<T>(statements: D1PreparedStatement[]) { sqlite.exec('BEGIN IMMEDIATE'); try {
		const results = statements.map((statement) => (statement as Executable)[execute]());
		sqlite.exec('COMMIT'); return results as D1Result<T>[];
	} catch (error) { sqlite.exec('ROLLBACK'); throw error; } } } as unknown as D1Database;
}

function fixture() {
	const sqlite = new DatabaseSync(':memory:');
	for (const filename of readdirSync(join(process.cwd(), 'migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
		sqlite.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
	}
	sqlite.exec(`INSERT INTO categories (id,slug,name,created_at) VALUES ('cat','cat','Category','${NOW}');
		INSERT INTO stories (id,slug,headline,deck,body_markdown,edition_date,category_id,status,social_excerpt,tags_json,created_at,updated_at)
		VALUES ('story','story','Headline','Deck','Body','2026-10-12','cat','APPROVED','Deck','[]','${NOW}','${NOW}');`);
	return { sqlite, repository: new D1ArticleImageRepository(d1(sqlite)) };
}

function pending(id: string, attemptKey = 'smoke:image:attempt:phase-3f-1') {
	return {
		id, storyId: 'story', provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2',
		prompt: 'Safe prompt', promptVersion: 'v1', aspectRatio: '3:2', altText: 'Safe alt text.',
		attemptKey, estimatedCostMicrousd: 42_000,
		pricingBasis: { size: '1536x1024', quality: 'medium', estimated: true },
		requestedByEmail: 'editor@test', requestedAt: NOW, auditId: `audit-${id}`,
	};
}

describe('durable image request reservations', () => {
	it('deduplicates concurrent manual and workflow services before provider submission', async () => {
		const { sqlite, repository } = fixture();
		const editorial = {
			findEditorialStoryById: async () => ({
				id: 'story', slug: 'story', headline: 'Headline', deck: 'Deck', bodyMarkdown: 'Body',
				editionDate: '2026-10-12', publishedAt: null, category: { id: 'cat', slug: 'cat', name: 'Category' },
				status: 'APPROVED', socialExcerpt: 'Deck', tags: [], ogImageKey: null,
				originCandidateId: null, updatedAt: NOW,
			}),
		} as unknown as EditorialRepository;
		const submit = async () => ({
			provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2',
			providerRequestId: 'provider-1', metadata: { submissionAccepted: true },
		});
		let submissions = 0;
		const provider: ImageProvider = {
			provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2', lifecycle: 'asynchronous',
			generationProfile: { aspectRatio: '3:2', size: '1536x1024', quality: 'medium', outputFormat: 'webp' },
			submit: async () => { submissions += 1; return submit(); },
		};
		const dependencies = {
			attemptKey: 'smoke:image:attempt:phase-3f-1', createWebhookUrl: async () => 'https://tomorrow-ish.news/callback',
			estimateCost: () => ({
				estimatedCostMicrousd: 42_000,
				basis: { provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2', aspectRatio: '3:2' as const,
					size: '1536x1024' as const, quality: 'medium' as const, outputFormat: 'webp' as const,
					textInputTokensConservative: 1, textInputPriceMicrousdPerToken: 5 as const,
					outputCostMicrousd: 41_000 as const, pricingVersion: 'openai-gpt-image-2-2026-10-12' as const },
			}),
		};
		const manual = new ArticleImageService(editorial, repository, provider, { put: async () => { throw new Error('unused'); }, delete: async () => undefined }, dependencies);
		const workflow = new ArticleImageService(editorial, repository, provider, { put: async () => { throw new Error('unused'); }, delete: async () => undefined }, dependencies);

		const outcomes = await Promise.allSettled([
			manual.generate({ email: 'editor@test' }, { storyId: 'story' }),
			workflow.generate({ email: 'automation@test' }, { storyId: 'story' }),
		]);
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		expect(submissions).toBe(1);
		expect(sqlite.prepare('SELECT COUNT(*) count FROM article_images').get()).toEqual({ count: 1 });
		sqlite.close();
	});

	it('allows only one concurrent reservation across routes and keeps ambiguity protective', async () => {
		const { sqlite, repository } = fixture();
		const results = await Promise.all([
			repository.recordPending(pending('manual')),
			repository.recordPending(pending('workflow')),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(sqlite.prepare("SELECT COUNT(*) count FROM article_images WHERE status='PENDING'").get()).toEqual({ count: 1 });
		expect(sqlite.prepare("SELECT COUNT(*) count FROM editorial_audit_log WHERE action='IMAGE_GENERATION_REQUESTED'").get()).toEqual({ count: 1 });

		const row = sqlite.prepare('SELECT id FROM article_images').get() as { id: string };
		expect(await repository.markPendingAmbiguous({
			imageId: row.id, providerRequestId: null, metadata: { stage: 'submission', outcome: 'unknown' },
			errorClassification: 'PROVIDER_TIMEOUT', errorMessage: 'Outcome unknown.', at: NOW, auditId: 'audit-ambiguous',
		})).toBe(true);
		expect(sqlite.prepare('SELECT status,attempt_state FROM article_images').get())
			.toEqual({ status: 'PENDING', attempt_state: 'AMBIGUOUS' });
		expect(await repository.recordPending(pending('second', 'smoke:image:attempt:phase-3f-2'))).toBe(false);
		expect(sqlite.prepare('SELECT COUNT(*) count FROM article_images').get()).toEqual({ count: 1 });
		sqlite.close();
	});

	it('lets a delayed callback resolve the original ambiguous attempt and preserves separate cost evidence', async () => {
		const { sqlite, repository } = fixture();
		await repository.recordPending(pending('image'));
		await repository.markPendingAmbiguous({
			imageId: 'image', providerRequestId: null, metadata: { outcome: 'unknown' },
			errorClassification: 'PROVIDER_TIMEOUT', errorMessage: 'Outcome unknown.', at: NOW, auditId: 'audit-ambiguous',
		});
		expect(await repository.attachSubmission({
			imageId: 'image', providerRequestId: 'provider-1', metadata: { recoveredFromWebhook: true },
			submittedAt: NOW, auditId: 'audit-submitted',
		})).toBe(true);
		expect(await repository.completePending({
			imageId: 'image', providerRequestId: 'provider-1', assetKey: 'article-images/story/image.webp',
			contentType: 'image/webp', byteSize: 100, metadata: { usage: { input_tokens: 200, output_tokens: 2800 } },
			generatedAt: NOW, auditId: 'audit-generated',
		})).toBe(true);
		expect(sqlite.prepare(`SELECT status,attempt_state,estimated_cost_microusd,
			provider_reported_usage_json,verified_billed_cost_microusd FROM article_images`).get()).toEqual({
			status: 'GENERATED', attempt_state: 'RESOLVED', estimated_cost_microusd: 42_000,
			provider_reported_usage_json: '{"input_tokens":200,"output_tokens":2800}',
			verified_billed_cost_microusd: null,
		});
		expect(await repository.recordPending(pending('replay'))).toBe(false);
		sqlite.close();
	});

	it('keeps lease-loss outcomes fenced against recovered-worker spending', async () => {
		const { sqlite, repository } = fixture();
		await repository.recordPending(pending('lease-owner-a'));
		await repository.markPendingAmbiguous({
			imageId: 'lease-owner-a', providerRequestId: null, metadata: { stage: 'lease-fence' },
			errorClassification: 'WORKFLOW_LEASE_LOST', errorMessage: 'Lease ownership was lost.',
			at: NOW, auditId: 'audit-lease-loss',
		});
		expect(await repository.hasPendingForStory('story')).toBe(true);
		expect(await repository.recordPending(pending('recovered-worker', 'smoke:image:attempt:recovered'))).toBe(false);
		expect(sqlite.prepare('SELECT status,attempt_state FROM article_images').get())
			.toEqual({ status: 'PENDING', attempt_state: 'AMBIGUOUS' });
		sqlite.close();
	});
});
