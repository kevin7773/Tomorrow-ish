import type { GovernedFeedSource } from './source-registry';

export const FRESHNESS_WINDOW_MS = 72 * 60 * 60 * 1_000;
export const MAX_SUMMARY_CHARACTERS = 2_000;
const MIN_SUMMARY_CHARACTERS = 40;

const TRACKING_PARAMETERS = new Set([
	'fbclid', 'gclid', 'dclid', 'mc_cid', 'mc_eid', 'igshid', 'mkt_tok',
]);

export interface AutomationFeedItem {
	title: string;
	neutralBrief: string;
	sourceTitle: string;
	sourceUrl: string;
	publisherName: string;
	sourceTier: GovernedFeedSource['sourceTier'];
	sourceType: GovernedFeedSource['sourceType'];
	publishedAt: string;
	categoryId: string;
}

export type EntrySkipReason =
	| 'MISSING_TITLE'
	| 'TITLE_TOO_LONG'
	| 'MISSING_SUMMARY'
	| 'SUMMARY_UNUSABLE'
	| 'MISSING_ARTICLE_URL'
	| 'INVALID_ARTICLE_URL'
	| 'ARTICLE_HOST_NOT_ALLOWED'
	| 'MISSING_PUBLICATION_DATE'
	| 'INVALID_PUBLICATION_DATE'
	| 'TOO_OLD';

export interface FeedEntryCandidate {
	title: unknown;
	summary: unknown;
	content: unknown;
	link: unknown;
	guid: unknown;
	publishedAt: unknown;
	categories: unknown[];
}

export type EntryNormalizationResult =
	| { item: AutomationFeedItem; reason: null }
	| { item: null; reason: EntrySkipReason };

function decodeSafeEntities(value: string): string {
	const named: Readonly<Record<string, string>> = {
		amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
	};
	return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
		if (entity.startsWith('#')) {
			const hexadecimal = entity[1]?.toLowerCase() === 'x';
			const parsed = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
			return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 0x10ffff
				? String.fromCodePoint(parsed)
				: match;
		}
		return named[entity.toLowerCase()] ?? match;
	});
}

export function cleanFeedText(value: string): string {
	return decodeSafeEntities(value)
		.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function textValue(value: unknown): string | null {
	if (typeof value === 'string' || typeof value === 'number') return String(value);
	if (Array.isArray(value)) {
		for (const entry of value) {
			const text = textValue(entry);
			if (text) return text;
		}
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	const record = value as Record<string, unknown>;
	return textValue(record['#text']) ?? textValue(record['#cdata']);
}

function hostnameAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
	const normalized = hostname.toLowerCase();
	return allowedHosts.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

export function canonicalArticleUrl(
	value: string,
	allowedHosts: readonly string[],
): { url: string; reason: null } | { url: null; reason: 'INVALID_ARTICLE_URL' | 'ARTICLE_HOST_NOT_ALLOWED' } {
	let url: URL;
	try { url = new URL(decodeSafeEntities(value).trim()); }
	catch { return { url: null, reason: 'INVALID_ARTICLE_URL' }; }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		return { url: null, reason: 'INVALID_ARTICLE_URL' };
	}
	if (!hostnameAllowed(url.hostname, allowedHosts)) {
		return { url: null, reason: 'ARTICLE_HOST_NOT_ALLOWED' };
	}
	url.hash = '';
	for (const key of Array.from(url.searchParams.keys())) {
		const normalized = key.toLowerCase();
		if (normalized.startsWith('utm_') || TRACKING_PARAMETERS.has(normalized)) {
			url.searchParams.delete(key);
		}
	}
	return { url: url.toString(), reason: null };
}

function boundedTitle(sourceTitle: string): string {
	if (sourceTitle.length <= 240) return sourceTitle;
	const prefix = sourceTitle.slice(0, 239);
	const wordBoundary = prefix.lastIndexOf(' ');
	return `${prefix.slice(0, wordBoundary >= 160 ? wordBoundary : 239).trimEnd()}…`;
}

function boundedSummary(summary: string): string {
	if (summary.length <= MAX_SUMMARY_CHARACTERS) return summary;
	const prefix = summary.slice(0, MAX_SUMMARY_CHARACTERS);
	const wordBoundary = prefix.lastIndexOf(' ');
	return prefix.slice(0, wordBoundary >= 1_800 ? wordBoundary : MAX_SUMMARY_CHARACTERS).trimEnd();
}

function categoryFor(source: GovernedFeedSource, categories: unknown[]): string {
	for (const raw of categories) {
		const value = textValue(raw);
		if (!value) continue;
		const mapped = source.categoryMappings?.[cleanFeedText(value).toLowerCase()];
		if (mapped) return mapped;
	}
	return source.fallbackCategoryId;
}

export function normalizeFeedEntry(
	entry: FeedEntryCandidate,
	source: GovernedFeedSource,
	now: Date,
): EntryNormalizationResult {
	const rawTitle = textValue(entry.title);
	if (!rawTitle) return { item: null, reason: 'MISSING_TITLE' };
	const sourceTitle = cleanFeedText(rawTitle);
	if (!sourceTitle) return { item: null, reason: 'MISSING_TITLE' };
	if (sourceTitle.length > 500) return { item: null, reason: 'TITLE_TOO_LONG' };

	const rawSummary = textValue(entry.summary) ?? textValue(entry.content);
	if (!rawSummary) return { item: null, reason: 'MISSING_SUMMARY' };
	const neutralBrief = boundedSummary(cleanFeedText(rawSummary));
	if (neutralBrief.length < MIN_SUMMARY_CHARACTERS || /^read more\.?$/i.test(neutralBrief)) {
		return { item: null, reason: 'SUMMARY_UNUSABLE' };
	}

	const rawLink = textValue(entry.link) ?? textValue(entry.guid);
	if (!rawLink) return { item: null, reason: 'MISSING_ARTICLE_URL' };
	const canonical = canonicalArticleUrl(rawLink, source.allowedArticleHosts);
	if (canonical.reason !== null) return { item: null, reason: canonical.reason };

	const rawPublishedAt = textValue(entry.publishedAt);
	if (!rawPublishedAt) return { item: null, reason: 'MISSING_PUBLICATION_DATE' };
	const published = new Date(rawPublishedAt);
	if (Number.isNaN(published.valueOf())) return { item: null, reason: 'INVALID_PUBLICATION_DATE' };
	if (published.valueOf() < now.valueOf() - FRESHNESS_WINDOW_MS) return { item: null, reason: 'TOO_OLD' };

	return {
		item: {
			title: boundedTitle(sourceTitle),
			neutralBrief,
			sourceTitle,
			sourceUrl: canonical.url,
			publisherName: source.publisherName,
			sourceTier: source.sourceTier,
			sourceType: source.sourceType,
			publishedAt: published.toISOString(),
			categoryId: categoryFor(source, entry.categories),
		},
		reason: null,
	};
}

export function extractTextValue(value: unknown): string | null {
	return textValue(value);
}
