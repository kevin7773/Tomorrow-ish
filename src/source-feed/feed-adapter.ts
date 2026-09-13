import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
	extractTextValue,
	normalizeFeedEntry,
	type AutomationFeedItem,
	type EntrySkipReason,
	type FeedEntryCandidate,
} from './feed-normalization';
import type { GovernedFeedSource } from './source-registry';

export const MAX_XML_RESPONSE_BYTES = 1_048_576;
export const FEED_TIMEOUT_MS = 5_000;
export const MAX_PARSED_ENTRIES_PER_SOURCE = 10;
export const MAX_NORMALIZED_ITEMS = 30;

type FeedFailureReason = 'TIMEOUT' | 'FETCH_EXCEPTION' | 'HTTP_STATUS' | 'OVERSIZE' | 'XML_DECLARATION' | 'XML_PARSE';
type FetchExceptionCode = 'ILLEGAL_INVOCATION' | 'ABORTED' | 'UNKNOWN';

export interface SourceFeedDiagnostic {
	sourceId: string;
	status: 'SUCCEEDED' | 'FAILED';
	parsedEntryCount: number;
	acceptedEntryCount: number;
	skippedEntryCount: number;
	skippedReasons: Partial<Record<EntrySkipReason, number>>;
	failureReason: FeedFailureReason | null;
	httpStatus: number | null;
	receivedHttpResponse: boolean;
	redirected: boolean | null;
	exceptionName: 'TypeError' | 'AbortError' | 'Error' | 'UnknownError' | null;
	exceptionCode: FetchExceptionCode | null;
}

export interface SourceFeedAggregation {
	items: AutomationFeedItem[];
	diagnostics: SourceFeedDiagnostic[];
	totalSourceFailure: boolean;
}

export interface AggregateSourceFeedsOptions {
	sources: readonly GovernedFeedSource[];
	transport?: typeof fetch;
	now?: () => Date;
	timeoutMs?: number;
	maxResponseBytes?: number;
	maxEntriesPerSource?: number;
	maxItems?: number;
}

class FeedFetchError extends Error {
	constructor(
		readonly reason: FeedFailureReason,
		readonly httpStatus: number | null = null,
		readonly exceptionName: SourceFeedDiagnostic['exceptionName'] = null,
		readonly exceptionCode: FetchExceptionCode | null = null,
	) {
		super(reason);
	}
}

function describeFetchException(error: unknown): Pick<FeedFetchError, 'exceptionName' | 'exceptionCode'> {
	if (error instanceof Error) {
		const exceptionName = error.name === 'TypeError' || error.name === 'AbortError' || error.name === 'Error'
			? error.name
			: 'UnknownError';
		const exceptionCode = /illegal invocation/i.test(error.message)
			? 'ILLEGAL_INVOCATION'
			: error.name === 'AbortError' ? 'ABORTED' : 'UNKNOWN';
		return { exceptionName, exceptionCode };
	}
	return { exceptionName: 'UnknownError', exceptionCode: 'UNKNOWN' };
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
	if (value === null || value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function atomLink(value: unknown): unknown {
	const links = asArray(value);
	const alternate = links.find((candidate) => {
		const link = record(candidate);
		return link && (!link['@_rel'] || link['@_rel'] === 'alternate') && typeof link['@_href'] === 'string';
	});
	return record(alternate)?.['@_href'] ?? alternate;
}

function rssLink(item: Record<string, unknown>): unknown {
	if (extractTextValue(item.link)) return item.link;
	const guid = record(item.guid);
	if (guid?.['@_isPermaLink'] === 'false') return null;
	return item.guid;
}

function candidateFromRss(item: Record<string, unknown>): FeedEntryCandidate {
	return {
		title: item.title,
		summary: item.description,
		content: item.encoded,
		link: rssLink(item),
		guid: null,
		publishedAt: item.pubDate ?? item.date ?? item.published ?? item.updated,
		categories: asArray(item.category),
	};
}

function candidateFromAtom(entry: Record<string, unknown>): FeedEntryCandidate {
	return {
		title: entry.title,
		summary: entry.summary,
		content: entry.content,
		link: atomLink(entry.link),
		guid: null,
		publishedAt: entry.published ?? entry.updated,
		categories: asArray(entry.category).map((category) => record(category)?.['@_term'] ?? category),
	};
}

export function parseFeedDocument(xml: string): FeedEntryCandidate[] {
	if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new FeedFetchError('XML_DECLARATION');
	if (XMLValidator.validate(xml) !== true) throw new FeedFetchError('XML_PARSE');
	let parsed: unknown;
	try {
		parsed = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: '@_',
			removeNSPrefix: true,
			parseTagValue: false,
			parseAttributeValue: false,
			trimValues: false,
			processEntities: false,
			isArray: (_name, path) => typeof path === 'string' && (
				path === 'rss.channel.item' || path === 'feed.entry' || path.endsWith('.link') || path.endsWith('.category')
			),
		}).parse(xml);
	} catch (error) {
		if (error instanceof FeedFetchError) throw error;
		throw new FeedFetchError('XML_PARSE');
	}
	const root = record(parsed);
	const rss = record(root?.rss);
	const channel = record(rss?.channel);
	if (channel) return asArray(channel.item).map(record).filter((item): item is Record<string, unknown> => Boolean(item)).map(candidateFromRss);
	const atom = record(root?.feed);
	if (atom) return asArray(atom.entry).map(record).filter((entry): entry is Record<string, unknown> => Boolean(entry)).map(candidateFromAtom);
	throw new FeedFetchError('XML_PARSE');
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
	const contentLength = Number(response.headers.get('Content-Length'));
	if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new FeedFetchError('OVERSIZE');
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = '';
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > maximumBytes) {
			await reader.cancel();
			throw new FeedFetchError('OVERSIZE');
		}
		text += decoder.decode(chunk.value, { stream: true });
	}
	return text + decoder.decode();
}

async function fetchOne(
	source: GovernedFeedSource,
	options: Required<Pick<AggregateSourceFeedsOptions, 'transport' | 'now' | 'timeoutMs' | 'maxResponseBytes' | 'maxEntriesPerSource'>>,
): Promise<{ items: AutomationFeedItem[]; diagnostic: SourceFeedDiagnostic }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
	let receivedHttpResponse = false;
	let redirected: boolean | null = null;
	try {
		let response: Response;
		try {
			// Cloudflare's global fetch validates its receiver. Detach it from the
			// options object so it is invoked as a function, not as an object method.
			const transport = options.transport;
			response = await transport(source.feedUrl, {
				headers: {
					Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
					'User-Agent': 'Tomorrow-ish governed source feed/1.0',
				},
				signal: controller.signal,
			});
		} catch (error) {
			const details = describeFetchException(error);
			throw new FeedFetchError(
				controller.signal.aborted ? 'TIMEOUT' : 'FETCH_EXCEPTION',
				null,
				details.exceptionName,
				details.exceptionCode,
			);
		}
		receivedHttpResponse = true;
		redirected = response.redirected;
		if (!response.ok) throw new FeedFetchError('HTTP_STATUS', response.status);
		const xml = await readBoundedBody(response, options.maxResponseBytes);
		const entries = parseFeedDocument(xml).slice(0, options.maxEntriesPerSource);
		const items: AutomationFeedItem[] = [];
		const skippedReasons: Partial<Record<EntrySkipReason, number>> = {};
		for (const entry of entries) {
			const normalized = normalizeFeedEntry(entry, source, options.now());
			if (normalized.item) items.push(normalized.item);
			else skippedReasons[normalized.reason] = (skippedReasons[normalized.reason] ?? 0) + 1;
		}
		return {
			items,
			diagnostic: {
				sourceId: source.id, status: 'SUCCEEDED', parsedEntryCount: entries.length,
				acceptedEntryCount: items.length, skippedEntryCount: entries.length - items.length,
				skippedReasons, failureReason: null, httpStatus: response.status,
				receivedHttpResponse, redirected, exceptionName: null, exceptionCode: null,
			},
		};
	} catch (error) {
		const failure = error instanceof FeedFetchError
			? error
			: new FeedFetchError(controller.signal.aborted ? 'TIMEOUT' : 'FETCH_EXCEPTION');
		return {
			items: [],
			diagnostic: {
				sourceId: source.id, status: 'FAILED', parsedEntryCount: 0,
				acceptedEntryCount: 0, skippedEntryCount: 0, skippedReasons: {},
				failureReason: failure.reason, httpStatus: failure.httpStatus,
				receivedHttpResponse, redirected,
				exceptionName: failure.exceptionName, exceptionCode: failure.exceptionCode,
			},
		};
	} finally {
		clearTimeout(timeout);
	}
}

export async function aggregateSourceFeeds(options: AggregateSourceFeedsOptions): Promise<SourceFeedAggregation> {
	const enabled = options.sources.filter((source) => source.enabled);
	const configured = {
		transport: options.transport ?? fetch,
		now: options.now ?? (() => new Date()),
		timeoutMs: options.timeoutMs ?? FEED_TIMEOUT_MS,
		maxResponseBytes: options.maxResponseBytes ?? MAX_XML_RESPONSE_BYTES,
		maxEntriesPerSource: options.maxEntriesPerSource ?? MAX_PARSED_ENTRIES_PER_SOURCE,
	};
	const results = await Promise.all(enabled.map((source) => fetchOne(source, configured)));
	const registryOrder = new Map(enabled.map((source, index) => [source.id, index]));
	const candidates = results.flatMap((result) => result.items.map((item) => ({
		item,
		sourceOrder: registryOrder.get(result.diagnostic.sourceId) ?? Number.MAX_SAFE_INTEGER,
	})));
	const compareCandidates = (left: (typeof candidates)[number], right: (typeof candidates)[number]) =>
		Date.parse(right.item.publishedAt) - Date.parse(left.item.publishedAt)
		|| left.item.sourceUrl.localeCompare(right.item.sourceUrl)
		|| left.sourceOrder - right.sourceOrder;
	candidates.sort(compareCandidates);
	const seen = new Set<string>();
	const unique = candidates.filter((candidate) => {
		if (seen.has(candidate.item.sourceUrl)) return false;
		seen.add(candidate.item.sourceUrl);
		return true;
	});
	const publisherBuckets = new Map<string, typeof unique>();
	for (const candidate of unique) {
		const bucket = publisherBuckets.get(candidate.item.publisherName) ?? [];
		bucket.push(candidate);
		publisherBuckets.set(candidate.item.publisherName, bucket);
	}
	const buckets = [...publisherBuckets.entries()].map(([publisherName, entries]) => ({
		publisherName,
		entries: entries.sort(compareCandidates),
		registryOrder: Math.min(...entries.map((entry) => entry.sourceOrder)),
	})).sort((left, right) =>
		Date.parse(right.entries[0].item.publishedAt) - Date.parse(left.entries[0].item.publishedAt)
		|| left.registryOrder - right.registryOrder
		|| left.publisherName.localeCompare(right.publisherName),
	);
	const items: AutomationFeedItem[] = [];
	const maximumItems = options.maxItems ?? MAX_NORMALIZED_ITEMS;
	while (items.length < maximumItems && buckets.some((bucket) => bucket.entries.length > 0)) {
		for (const bucket of buckets) {
			const candidate = bucket.entries.shift();
			if (candidate) items.push(candidate.item);
			if (items.length >= maximumItems) break;
		}
	}
	return {
		items,
		diagnostics: results.map((result) => result.diagnostic),
		totalSourceFailure: enabled.length === 0 || results.every((result) => result.diagnostic.status === 'FAILED'),
	};
}
