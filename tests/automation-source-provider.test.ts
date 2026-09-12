import { describe, expect, it } from 'vitest';
import { HttpAutomationSourceProvider } from '../src/automation/http-source-provider';
import { AutomationSourceProviderError } from '../src/automation/source-provider';

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('HTTP automation source provider', () => {
	it('validates and normalizes bounded source metadata without fetching article URLs', async () => {
		const transport = async () => response({ items: [{
			title: 'Reported event', neutralBrief: 'A neutral factual account of the reported event.',
			sourceTitle: 'Original headline', sourceUrl: 'https://NEWS.example.test/report#fragment',
			publisherName: 'Newsroom', sourceTier: 'TIER_1', sourceType: 'STRAIGHT_NEWS',
			publishedAt: '2026-09-12T12:00:00Z', categoryId: 'cat-civic-life',
		}] });
		const items = await new HttpAutomationSourceProvider('https://feed.example.test/items', transport).discover(3);
		expect(items).toHaveLength(1);
		expect(items[0].source).toMatchObject({
			sourceUrl: 'https://news.example.test/report#fragment',
			publisherName: 'Newsroom', sourceTitle: 'Original headline',
		});
		expect(items[0].itemIdentity).toMatch(/^[a-f0-9]{64}$/);
	});

	it('isolates malformed items instead of rejecting valid neighbors', async () => {
		const transport = async () => response({ items: [
			{ title: 'Missing metadata' },
			{ title: 'Valid event', neutralBrief: 'A complete neutral factual account.', sourceTitle: 'Headline',
				sourceUrl: 'https://news.example.test/valid', publisherName: 'Newsroom',
				sourceTier: 'TIER_1', sourceType: 'PRIMARY', categoryId: 'cat-science' },
		] });
		const items = await new HttpAutomationSourceProvider('https://feed.example.test/items', transport).discover(3);
		expect(items[0]).toMatchObject({ source: null, sourceUrl: null });
		expect(items[0].errorReason).toBeTruthy();
		expect(items[1].source?.sourceUrl).toBe('https://news.example.test/valid');
	});

	it('classifies a rejected discovery endpoint without exposing its response', async () => {
		const provider = new HttpAutomationSourceProvider('https://feed.example.test/items', async () => response({ secret: 'not retained' }, 503));
		await expect(provider.discover(3)).rejects.toEqual(expect.objectContaining<Partial<AutomationSourceProviderError>>({
			classification: 'REJECTED',
		}));
	});
});
