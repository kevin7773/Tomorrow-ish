import { describe, expect, it } from 'vitest';
import {
	aggregateSourceFeeds,
	parseFeedDocument,
} from '../src/source-feed/feed-adapter';
import type { GovernedFeedSource } from '../src/source-feed/source-registry';
import { GOVERNED_FEED_SOURCES } from '../src/source-feed/source-registry';

const NOW = new Date('2026-09-12T18:00:00Z');

function source(overrides: Partial<GovernedFeedSource> = {}): GovernedFeedSource {
	return {
		id: 'example-news', publisherName: 'Example News', feedUrl: 'https://feeds.example.test/news.xml',
		sourceTier: 'TIER_1', sourceType: 'STRAIGHT_NEWS', fallbackCategoryId: 'cat-community',
		enabled: true, allowedArticleHosts: ['example.test'], ...overrides,
	};
}

function itemXml(input: { title?: string; description?: string | null; link?: string; date?: string; category?: string } = {}): string {
	return `<item>
		<title><![CDATA[${input.title ?? 'A reported event'}]]></title>
		${input.description === null ? '' : `<description><![CDATA[${input.description ?? 'A sufficiently detailed factual summary of the reported event.'}]]></description>`}
		<link>${(input.link ?? 'https://example.test/story').replaceAll('&', '&amp;')}</link>
		<pubDate>${input.date ?? 'Sat, 12 Sep 2026 17:00:00 GMT'}</pubDate>
		${input.category ? `<category>${input.category}</category>` : ''}
	</item>`;
}

function rss(items: string[]): string {
	return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items.join('')}</channel></rss>`;
}

function response(body: string, status = 200): Response {
	return new Response(body, { status, headers: { 'Content-Type': 'application/xml' } });
}

describe('governed source-feed adapter', () => {
	it('normalizes RSS metadata, strips HTML, removes only approved tracking, and uses the category fallback', async () => {
		const transport = async () => response(rss([itemXml({
			title: '  Original &amp; exact headline  ',
			description: '<p>A <strong>neutral</strong> report&nbsp;with enough factual detail.</p><script>secret()</script>',
			link: 'https://NEWS.example.test/story?utm_source=rss&story=7&fbclid=abc#section',
		})]));
		const result = await aggregateSourceFeeds({ sources: [source()], transport, now: () => NOW });
		expect(result.items).toEqual([expect.objectContaining({
			title: 'Original & exact headline', sourceTitle: 'Original & exact headline',
			neutralBrief: 'A neutral report with enough factual detail.',
			sourceUrl: 'https://news.example.test/story?story=7',
			publisherName: 'Example News', sourceTier: 'TIER_1', sourceType: 'STRAIGHT_NEWS',
			publishedAt: '2026-09-12T17:00:00.000Z', categoryId: 'cat-community',
		})]);
	});

	it('normalizes Atom metadata and explicit category mappings', async () => {
		const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title><entry>
			<title type="html">Atom headline</title><summary type="html">A factual Atom summary with enough information to use safely.</summary>
			<link rel="alternate" href="https://example.test/atom-story?gclid=gone" />
			<published>2026-09-12T16:00:00Z</published><category term="science" />
		</entry></feed>`;
		const result = await aggregateSourceFeeds({
			sources: [source({ categoryMappings: { science: 'cat-science' } })],
			transport: async () => response(atom), now: () => NOW,
		});
		expect(result.items[0]).toMatchObject({
			sourceTitle: 'Atom headline', sourceUrl: 'https://example.test/atom-story', categoryId: 'cat-science',
		});
	});

	it('isolates malformed and missing-summary entries', async () => {
		const xml = rss([
			itemXml({ title: 'No summary', description: null, link: 'https://example.test/no-summary' }),
			'<item><title>Malformed neighbor</title></item>',
			itemXml({ title: 'Valid neighbor', link: 'https://example.test/valid' }),
		]);
		const result = await aggregateSourceFeeds({ sources: [source()], transport: async () => response(xml), now: () => NOW });
		expect(result.items.map((item) => item.sourceTitle)).toEqual(['Valid neighbor']);
		expect(result.diagnostics[0]).toMatchObject({ parsedEntryCount: 3, acceptedEntryCount: 1, skippedEntryCount: 2 });
		expect(result.diagnostics[0].skippedReasons).toEqual({ MISSING_SUMMARY: 2 });
	});

	it('isolates an unavailable feed from a healthy feed', async () => {
		const broken = source({ id: 'broken', feedUrl: 'https://broken.example.test/feed.xml', allowedArticleHosts: ['broken.example.test'] });
		const healthy = source({ id: 'healthy' });
		const result = await aggregateSourceFeeds({
			sources: [broken, healthy], now: () => NOW,
			transport: async (url) => String(url).includes('broken') ? response('unavailable', 503) : response(rss([itemXml()])),
		});
		expect(result.totalSourceFailure).toBe(false);
		expect(result.items).toHaveLength(1);
		expect(result.diagnostics).toEqual(expect.arrayContaining([
			expect.objectContaining({ sourceId: 'broken', status: 'FAILED', failureReason: 'HTTP_STATUS', httpStatus: 503 }),
			expect.objectContaining({ sourceId: 'healthy', status: 'SUCCEEDED' }),
		]));
	});

	it('suppresses duplicate canonical URLs and orders newest items deterministically', async () => {
		const xml = rss([
			itemXml({ title: 'Older duplicate', link: 'https://example.test/shared?utm_medium=rss', date: 'Sat, 12 Sep 2026 15:00:00 GMT' }),
			itemXml({ title: 'Newest', link: 'https://example.test/z', date: 'Sat, 12 Sep 2026 17:00:00 GMT' }),
			itemXml({ title: 'Newer duplicate', link: 'https://example.test/shared', date: 'Sat, 12 Sep 2026 16:00:00 GMT' }),
			itemXml({ title: 'Same time A', link: 'https://example.test/a', date: 'Sat, 12 Sep 2026 14:00:00 GMT' }),
			itemXml({ title: 'Same time B', link: 'https://example.test/b', date: 'Sat, 12 Sep 2026 14:00:00 GMT' }),
		]);
		const result = await aggregateSourceFeeds({ sources: [source()], transport: async () => response(xml), now: () => NOW });
		expect(result.items.map((item) => item.sourceTitle)).toEqual(['Newest', 'Newer duplicate', 'Same time A', 'Same time B']);
	});

	it('rejects old entries and disallowed article hosts', async () => {
		const xml = rss([
			itemXml({ title: 'Old', link: 'https://example.test/old', date: 'Tue, 08 Sep 2026 17:00:00 GMT' }),
			itemXml({ title: 'Wrong host', link: 'https://attacker.example/story' }),
		]);
		const result = await aggregateSourceFeeds({ sources: [source()], transport: async () => response(xml), now: () => NOW });
		expect(result.items).toEqual([]);
		expect(result.diagnostics[0].skippedReasons).toEqual({ TOO_OLD: 1, ARTICLE_HOST_NOT_ALLOWED: 1 });
	});

	it('enforces the ten-entry source cap and thirty-item response cap', async () => {
		const sources = Array.from({ length: 4 }, (_, sourceIndex) => source({
			id: `source-${sourceIndex}`,
			feedUrl: `https://feeds.example.test/source-${sourceIndex}.xml`,
		}));
		const result = await aggregateSourceFeeds({
			sources, now: () => NOW,
			transport: async (url) => {
				const sourceId = String(url).match(/source-(\d+)/)?.[1] ?? '0';
				return response(rss(Array.from({ length: 15 }, (_, itemIndex) => itemXml({
					title: `Source ${sourceId} item ${itemIndex}`,
					link: `https://example.test/source-${sourceId}/item-${itemIndex}`,
				}))));
			},
		});
		expect(result.diagnostics.every((diagnostic) => diagnostic.parsedEntryCount === 10)).toBe(true);
		expect(result.items).toHaveLength(30);
	});

	it('rejects DTD and entity declarations before parsing', () => {
		expect(() => parseFeedDocument('<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///secret">]><rss/>')).toThrow('XML_DECLARATION');
	});

	it.runIf(process.env.RUN_LIVE_SOURCE_FEEDS === 'true')('validates the approved feeds without persistence', async () => {
		const result = await aggregateSourceFeeds({ sources: GOVERNED_FEED_SOURCES });
		console.table(result.diagnostics.map((diagnostic) => ({
			source: diagnostic.sourceId,
			status: diagnostic.status,
			parsed: diagnostic.parsedEntryCount,
			accepted: diagnostic.acceptedEntryCount,
			skipped: diagnostic.skippedEntryCount,
			reasons: JSON.stringify(diagnostic.skippedReasons),
			failure: diagnostic.failureReason ?? '',
		})));
		console.log(JSON.stringify({ items: result.items.slice(0, 1) }, null, 2));
		expect(result.diagnostics).toHaveLength(GOVERNED_FEED_SOURCES.length);
	});
});
