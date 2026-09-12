import { sha256 } from '../ai/model-runner';
import { isSourceTier, isSourceType, isValidSourceAuthority } from '../domain/editorial';
import type { DiscoveryItem, DiscoveredSource } from '../domain/automation';
import { optionalTimestamp, requiredText, sourceUrl } from '../services/validation';
import { AutomationSourceProviderError, type AutomationSourceProvider } from './source-provider';

const MAX_RESPONSE_CHARACTERS = 1_000_000;
const DISCOVERY_TIMEOUT_MS = 8_000;

function canonicalIdentityUrl(value: string): string {
	const parsed = new URL(value);
	parsed.hash = '';
	parsed.hostname = parsed.hostname.toLowerCase();
	return parsed.toString();
}

async function invalidItem(index: number, raw: unknown, reason: string): Promise<DiscoveryItem> {
	const serialized = JSON.stringify(raw)?.slice(0, 4_000) ?? String(raw).slice(0, 4_000);
	return {
		itemIdentity: `invalid:${index}:${await sha256(serialized)}`,
		sourceUrl: null,
		source: null,
		errorReason: reason,
	};
}

async function parseItem(raw: unknown, index: number): Promise<DiscoveryItem> {
	try {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ITEM_NOT_OBJECT');
		const item = raw as Record<string, unknown>;
		const normalizedUrl = sourceUrl(item.sourceUrl);
		const sourceTier = item.sourceTier;
		const sourceType = item.sourceType;
		if (!isSourceTier(sourceTier) || !isSourceType(sourceType) || !isValidSourceAuthority(sourceTier, sourceType)) {
			throw new Error('INVALID_SOURCE_AUTHORITY');
		}
		const source: DiscoveredSource = {
			itemIdentity: await sha256(`automation-source-v1\n${canonicalIdentityUrl(normalizedUrl)}`),
			title: requiredText(item.title, 'Title', 240),
			neutralBrief: requiredText(item.neutralBrief, 'Neutral brief', 20_000),
			sourceTitle: requiredText(item.sourceTitle, 'Source title', 500),
			sourceUrl: normalizedUrl,
			publisherName: requiredText(item.publisherName, 'Publisher name', 240),
			sourceTier,
			sourceType,
			publishedAt: optionalTimestamp(item.publishedAt, 'Source publication time'),
			categoryId: requiredText(item.categoryId, 'Category ID', 100),
		};
		return { itemIdentity: source.itemIdentity, sourceUrl: source.sourceUrl, source, errorReason: null };
	} catch (error) {
		return invalidItem(index, raw, error instanceof Error ? error.message.slice(0, 120) : 'INVALID_ITEM');
	}
}

export class HttpAutomationSourceProvider implements AutomationSourceProvider {
	constructor(
		private readonly endpoint: string,
		private readonly transport: typeof fetch = fetch,
	) {}

	async discover(limit: number): Promise<DiscoveryItem[]> {
		if (!this.endpoint.trim()) throw new AutomationSourceProviderError('NOT_CONFIGURED');
		let endpoint: string;
		try { endpoint = sourceUrl(this.endpoint); }
		catch { throw new AutomationSourceProviderError('NOT_CONFIGURED'); }

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
		let response: Response;
		try {
			response = await this.transport(endpoint, {
				headers: { Accept: 'application/json', 'User-Agent': 'Tomorrow-ish source discovery/1.0' },
				signal: controller.signal,
			});
		} catch {
			throw new AutomationSourceProviderError('NETWORK');
		} finally {
			clearTimeout(timeout);
		}
		if (!response.ok) throw new AutomationSourceProviderError('REJECTED');
		const text = await response.text();
		if (text.length > MAX_RESPONSE_CHARACTERS) throw new AutomationSourceProviderError('MALFORMED_RESPONSE');
		let payload: unknown;
		try { payload = JSON.parse(text); }
		catch { throw new AutomationSourceProviderError('MALFORMED_RESPONSE'); }
		if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { items?: unknown }).items)) {
			throw new AutomationSourceProviderError('MALFORMED_RESPONSE');
		}
		const bounded = (payload as { items: unknown[] }).items.slice(0, limit);
		return Promise.all(bounded.map(parseItem));
	}
}
