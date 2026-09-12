import type { APIRoute } from 'astro';
import { getStoryRepository } from '../data/runtime-story-repository';
import { absoluteSiteUrl } from '../lib/metadata';

const staticPaths = ['/', '/latest', '/archive', '/categories', '/about', '/contact', '/privacy', '/terms'];

interface SitemapEntry {
	location: string;
	lastModified?: string;
}

export const GET: APIRoute = async () => {
	const repository = getStoryRepository();
	const [stories, categories] = await Promise.all([
		repository.listPublished({ limit: 100 }),
		repository.listCategories(),
	]);
	const urls: SitemapEntry[] = [
		...staticPaths.map((path) => ({ location: absoluteSiteUrl(path) })),
		...categories.map((category) => ({ location: absoluteSiteUrl(`/category/${category.slug}`) })),
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
