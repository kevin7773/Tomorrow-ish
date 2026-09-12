import { aggregateSourceFeeds, type AggregateSourceFeedsOptions, type SourceFeedAggregation } from '../source-feed/feed-adapter';
import { GOVERNED_FEED_SOURCES } from '../source-feed/source-registry';
import { discoveryItemsFromFeedItems, HttpAutomationSourceProvider } from './http-source-provider';
import { AutomationSourceProviderError, type AutomationSourceProvider } from './source-provider';

export const GOVERNED_AUTOMATION_SOURCE_URL = 'https://tomorrow-ish.news/api/automation/source-feed';

type GovernedFeedAggregator = (options: AggregateSourceFeedsOptions) => Promise<SourceFeedAggregation>;

export function isGovernedAutomationSourceUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.toString() === GOVERNED_AUTOMATION_SOURCE_URL;
	} catch {
		return false;
	}
}

export class GovernedAutomationSourceProvider implements AutomationSourceProvider {
	constructor(private readonly aggregate: GovernedFeedAggregator = aggregateSourceFeeds) {}

	async discover(limit: number) {
		const result = await this.aggregate({
			sources: GOVERNED_FEED_SOURCES,
			maxItems: limit,
		});
		if (result.totalSourceFailure) throw new AutomationSourceProviderError('NETWORK');
		return discoveryItemsFromFeedItems(result.items, limit);
	}
}

export function automationSourceProvider(endpoint: string): AutomationSourceProvider {
	return isGovernedAutomationSourceUrl(endpoint)
		? new GovernedAutomationSourceProvider()
		: new HttpAutomationSourceProvider(endpoint);
}
