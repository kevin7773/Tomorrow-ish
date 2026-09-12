import type { SourceTier, SourceType } from '../domain/editorial';

export interface GovernedFeedSource {
	id: string;
	publisherName: string;
	feedUrl: string;
	sourceTier: SourceTier;
	sourceType: SourceType;
	fallbackCategoryId: string;
	enabled: boolean;
	allowedArticleHosts: readonly string[];
	categoryMappings?: Readonly<Record<string, string>>;
}

export const GOVERNED_FEED_SOURCES = [
	{
		id: 'nasa-news-releases',
		publisherName: 'NASA',
		feedUrl: 'https://www.nasa.gov/news-release/feed/',
		sourceTier: 'TIER_1',
		sourceType: 'PRIMARY',
		fallbackCategoryId: 'cat-science',
		enabled: true,
		allowedArticleHosts: ['nasa.gov'],
	},
	{
		id: 'npr-national',
		publisherName: 'NPR',
		feedUrl: 'https://feeds.npr.org/1003/rss.xml',
		sourceTier: 'TIER_1',
		sourceType: 'STRAIGHT_NEWS',
		fallbackCategoryId: 'cat-civic-life',
		enabled: true,
		allowedArticleHosts: ['npr.org'],
	},
	{
		id: 'npr-science',
		publisherName: 'NPR',
		feedUrl: 'https://feeds.npr.org/1007/rss.xml',
		sourceTier: 'TIER_1',
		sourceType: 'STRAIGHT_NEWS',
		fallbackCategoryId: 'cat-science',
		enabled: true,
		allowedArticleHosts: ['npr.org'],
	},
	{
		id: 'bbc-science-environment',
		publisherName: 'BBC News',
		feedUrl: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
		sourceTier: 'TIER_1',
		sourceType: 'STRAIGHT_NEWS',
		fallbackCategoryId: 'cat-science',
		enabled: true,
		allowedArticleHosts: ['bbc.co.uk', 'bbc.com'],
	},
	{
		id: 'espn-top-headlines',
		publisherName: 'ESPN',
		feedUrl: 'https://www.espn.com/espn/rss/news',
		sourceTier: 'TIER_2',
		sourceType: 'STRAIGHT_NEWS',
		fallbackCategoryId: 'cat-sports',
		enabled: true,
		allowedArticleHosts: ['espn.com'],
	},
	{
		id: 'wfla-florida-news',
		publisherName: 'WFLA News Channel 8',
		feedUrl: 'https://www.wfla.com/news/florida/feed/',
		sourceTier: 'TIER_2',
		sourceType: 'LOCAL_NEWS',
		fallbackCategoryId: 'cat-florida-probably',
		enabled: true,
		allowedArticleHosts: ['wfla.com'],
	},
	{
		id: 'yellowstone-national-park',
		publisherName: 'Yellowstone National Park',
		feedUrl: 'https://www.nps.gov/feeds/getNewsRSS.htm?id=yell',
		sourceTier: 'TIER_1',
		sourceType: 'PRIMARY',
		fallbackCategoryId: 'cat-community',
		enabled: true,
		allowedArticleHosts: ['nps.gov'],
	},
] as const satisfies readonly GovernedFeedSource[];
