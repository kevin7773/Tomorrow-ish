import type { APIRoute } from 'astro';
import { aggregateSourceFeeds, type SourceFeedDiagnostic } from '../../../source-feed/feed-adapter';
import { GOVERNED_FEED_SOURCES } from '../../../source-feed/source-registry';

const CACHE_SECONDS = 300;

export interface SourceFeedCache {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
}

export interface SourceFeedEndpointOptions {
	transport?: typeof fetch;
	now?: () => Date;
	cache?: SourceFeedCache | null;
	logger?: Pick<Console, 'info' | 'warn'>;
}

function logDiagnostics(logger: Pick<Console, 'info' | 'warn'>, diagnostics: SourceFeedDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const details = {
			sourceId: diagnostic.sourceId,
			status: diagnostic.status,
			parsedEntryCount: diagnostic.parsedEntryCount,
			acceptedEntryCount: diagnostic.acceptedEntryCount,
			skippedEntryCount: diagnostic.skippedEntryCount,
			skippedReasons: diagnostic.skippedReasons,
			failureReason: diagnostic.failureReason,
			httpStatus: diagnostic.httpStatus,
		};
		if (diagnostic.status === 'FAILED') logger.warn('[source-feed] source failed', details);
		else logger.info('[source-feed] source completed', details);
	}
}

function jsonResponse(items: unknown[], status = 200): Response {
	return Response.json({ items }, {
		status,
		headers: {
			'Cache-Control': status === 200 ? `public, max-age=0, s-maxage=${CACHE_SECONDS}` : 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'X-Robots-Tag': 'noindex, nofollow',
		},
	});
}

export async function handleSourceFeedRequest(
	request: Request,
	options: SourceFeedEndpointOptions = {},
): Promise<Response> {
	const url = new URL(request.url);
	if (url.search) return jsonResponse([], 400);
	const logger = options.logger ?? console;
	const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
	if (options.cache) {
		try {
			const cached = await options.cache.match(cacheKey);
			if (cached) return cached;
		} catch { logger.warn('[source-feed] cache read failed'); }
	}
	const aggregation = await aggregateSourceFeeds({
		sources: GOVERNED_FEED_SOURCES,
		transport: options.transport,
		now: options.now,
	});
	logDiagnostics(logger, aggregation.diagnostics);
	if (aggregation.totalSourceFailure) return jsonResponse([], 502);
	const response = jsonResponse(aggregation.items);
	if (options.cache) {
		try { await options.cache.put(cacheKey, response.clone()); }
		catch { logger.warn('[source-feed] cache write failed'); }
	}
	return response;
}

export const GET: APIRoute = async ({ request }) => handleSourceFeedRequest(request, {
	cache: (caches as unknown as { default: SourceFeedCache }).default,
});
