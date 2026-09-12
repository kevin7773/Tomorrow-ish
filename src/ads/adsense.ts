export const ADSENSE_PUBLISHER_ID = 'ca-pub-4913684525326701';
export const ADS_TXT_ENTRY = 'google.com, pub-4913684525326701, DIRECT, f08c47fec0942fa0';

export const AD_PLACEMENTS = {
	ARTICLE_INLINE_1: 'ARTICLE_INLINE_1',
	ARTICLE_INLINE_2: 'ARTICLE_INLINE_2',
	DESKTOP_SIDEBAR: 'DESKTOP_SIDEBAR',
} as const;

export type AdPlacement = (typeof AD_PLACEMENTS)[keyof typeof AD_PLACEMENTS];

export interface AdSenseEnvironment {
	ADS_ENABLED?: string;
	ADSENSE_ARTICLE_INLINE_1_SLOT?: string;
	ADSENSE_ARTICLE_INLINE_2_SLOT?: string;
	ADSENSE_DESKTOP_SIDEBAR_SLOT?: string;
}

const slotBindingByPlacement: Record<AdPlacement, keyof AdSenseEnvironment> = {
	ARTICLE_INLINE_1: 'ADSENSE_ARTICLE_INLINE_1_SLOT',
	ARTICLE_INLINE_2: 'ADSENSE_ARTICLE_INLINE_2_SLOT',
	DESKTOP_SIDEBAR: 'ADSENSE_DESKTOP_SIDEBAR_SLOT',
};

export function isAdsEnabled(environment: Pick<AdSenseEnvironment, 'ADS_ENABLED'>): boolean {
	return environment.ADS_ENABLED === 'true';
}

export function getAdSenseSlot(
	environment: AdSenseEnvironment,
	placement: AdPlacement,
): string | null {
	const value = environment[slotBindingByPlacement[placement]]?.trim() ?? '';
	return /^\d+$/.test(value) ? value : null;
}

export function shouldLoadAdSense(
	environment: AdSenseEnvironment,
	placements: readonly AdPlacement[],
): boolean {
	return isAdsEnabled(environment) && placements.some((placement) => getAdSenseSlot(environment, placement) !== null);
}

export interface ArticleInlinePlacement {
	placement: Extract<AdPlacement, 'ARTICLE_INLINE_1' | 'ARTICLE_INLINE_2'>;
	afterParagraph: number;
}

export function getArticleInlinePlacements(paragraphCount: number): ArticleInlinePlacement[] {
	if (paragraphCount < 4) return [];
	if (paragraphCount < 6) return [{ placement: AD_PLACEMENTS.ARTICLE_INLINE_1, afterParagraph: 2 }];
	return [
		{ placement: AD_PLACEMENTS.ARTICLE_INLINE_1, afterParagraph: 2 },
		{ placement: AD_PLACEMENTS.ARTICLE_INLINE_2, afterParagraph: 5 },
	];
}
