import { describe, expect, it, vi } from 'vitest';
import { handleSourceFeedRequest, type SourceFeedCache } from '../src/pages/api/automation/source-feed';

function articleUrl(feedUrl: string): string {
	if (feedUrl.includes('nasa.gov')) return 'https://www.nasa.gov/news-release/example/';
	if (feedUrl.includes('npr.org')) return 'https://www.npr.org/2026/09/12/example';
	if (feedUrl.includes('bbc.co.uk')) return 'https://www.bbc.com/news/articles/example';
	if (feedUrl.includes('espn.com')) return 'https://www.espn.com/example/story';
	if (feedUrl.includes('wfla.com')) return 'https://www.wfla.com/news/florida/example/';
	return 'https://www.nps.gov/yell/learn/news/example.htm';
}

function feed(url: string, date = 'Sat, 12 Sep 2026 17:00:00 GMT'): Response {
	const article = articleUrl(url).replaceAll('&', '&amp;');
	return new Response(`<?xml version="1.0"?><rss><channel><item><title>Feed headline</title>
		<description>A sufficiently detailed factual summary from the source feed.</description>
		<link>${article}</link><pubDate>${date}</pubDate></item></channel></rss>`, { status: 200 });
}

const quietLogger = { info: vi.fn(), warn: vi.fn() };

describe('source-feed endpoint', () => {
	it('returns the exact contract and caches a successful generated response for five minutes', async () => {
		const stored: Response[] = [];
		const cache: SourceFeedCache = {
			match: vi.fn(async () => undefined),
			put: vi.fn(async (_request, response) => { stored.push(response); }),
		};
		const response = await handleSourceFeedRequest(new Request('https://tomorrow-ish.news/api/automation/source-feed'), {
			transport: async (url) => feed(String(url)), now: () => new Date('2026-09-12T18:00:00Z'), cache, logger: quietLogger,
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=300');
		expect(Object.keys(await response.clone().json())).toEqual(['items']);
		const payload = await response.json() as { items: unknown[] };
		expect(payload.items.length).toBeGreaterThan(0);
		expect(cache.put).toHaveBeenCalledOnce();
		expect(stored).toHaveLength(1);
	});

	it('does not accept query-controlled feed inputs', async () => {
		const transport = vi.fn();
		const response = await handleSourceFeedRequest(
			new Request('https://tomorrow-ish.news/api/automation/source-feed?url=https://attacker.example/feed'),
			{ transport, cache: null, logger: quietLogger },
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ items: [] });
		expect(transport).not.toHaveBeenCalled();
	});

	it('returns a bounded 502 only when every enabled source fails', async () => {
		const response = await handleSourceFeedRequest(new Request('https://tomorrow-ish.news/api/automation/source-feed'), {
			transport: async () => new Response('arbitrary upstream error body', { status: 503 }),
			cache: null, logger: quietLogger,
		});
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ items: [] });
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	it('logs only bounded metadata for fetch exceptions', async () => {
		const logger = { info: vi.fn(), warn: vi.fn() };
		const response = await handleSourceFeedRequest(new Request('https://tomorrow-ish.news/api/automation/source-feed'), {
			transport: async () => { throw new TypeError('Illegal invocation: private upstream detail'); },
			cache: null,
			logger,
		});
		expect(response.status).toBe(502);
		expect(logger.warn).toHaveBeenCalled();
		const diagnostic = logger.warn.mock.calls[0]?.[1];
		expect(diagnostic).toMatchObject({
			failureReason: 'FETCH_EXCEPTION', receivedHttpResponse: false,
			exceptionName: 'TypeError', exceptionCode: 'ILLEGAL_INVOCATION',
		});
		expect(JSON.stringify(diagnostic)).not.toContain('private upstream detail');
	});

	it('returns a healthy empty contract when feeds have no recent usable entries', async () => {
		const response = await handleSourceFeedRequest(new Request('https://tomorrow-ish.news/api/automation/source-feed'), {
			transport: async (url) => feed(String(url), 'Tue, 01 Sep 2026 17:00:00 GMT'),
			now: () => new Date('2026-09-12T18:00:00Z'), cache: null, logger: quietLogger,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ items: [] });
	});
});
