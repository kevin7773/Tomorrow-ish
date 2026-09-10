export const SITE_NAME = 'Tomorrow-ish';
export const SITE_URL = 'https://tomorrow-ish.news';
export const SITE_DESCRIPTION = "Tomorrow's news. Approximately. A clearly labeled satirical newspaper.";

export interface PageMetadata {
	title: string;
	description: string;
	canonicalUrl: string;
	openGraphType: 'website' | 'article';
	imageUrl?: string;
}

export function absoluteSiteUrl(pathname: string): string {
	return new URL(pathname, SITE_URL).toString();
}

export function buildPageMetadata(options: {
	title?: string;
	description?: string;
	canonicalPath?: string;
	type?: 'website' | 'article';
	imageUrl?: string | null;
} = {}): PageMetadata {
	return {
		title: options.title ? `${options.title} | ${SITE_NAME}` : `${SITE_NAME} | Tomorrow's news. Approximately.`,
		description: options.description ?? SITE_DESCRIPTION,
		canonicalUrl: absoluteSiteUrl(options.canonicalPath ?? '/'),
		openGraphType: options.type ?? 'website',
		...(options.imageUrl ? { imageUrl: absoluteSiteUrl(options.imageUrl) } : {}),
	};
}

export function serializeJsonLd(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}
