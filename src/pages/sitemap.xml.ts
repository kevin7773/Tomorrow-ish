import type { APIRoute } from 'astro';
import { getStoryRepository } from '../data/runtime-story-repository';
import { absoluteSiteUrl } from '../lib/metadata';

const staticPaths = ['/', '/latest', '/archive', '/about', '/privacy', '/terms'];

interface SitemapEntry {
	location: string;
	lastModified?: string;
}

export const GET: APIRoute = async () => {
	const repository = getStoryRepository();
	const stories = await repository.listPublished({ limit: 100 });
	const urls: SitemapEntry[] = [
		...staticPaths.map((path) => ({ location: absoluteSiteUrl(path) })),
		...stories.map((story) => ({
			location: absoluteSiteUrl(`/story/${story.slug}`),
			lastModified: story.publishedAt,
		})),
	];
	const entries = urls.map(({ location, lastModified }) => [
		'<url>',
		`<loc>${location}</loc>`,
		...(lastModified ? [`<lastmod>${lastModified}</lastmod>`] : []),
		'</url>',
	].join('')).join('');

	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`,
		{ headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
	);
};
