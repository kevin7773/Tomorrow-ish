import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	ADSENSE_PUBLISHER_ID,
	ADS_TXT_ENTRY,
	AD_PLACEMENTS,
	getAdSenseSlot,
	getArticleInlinePlacements,
	isAdsEnabled,
	shouldLoadAdSense,
} from '../src/ads/adsense';

const root = process.cwd();

function source(path: string): string {
	return readFileSync(join(root, path), 'utf8');
}

function filesBelow(path: string): string[] {
	return readdirSync(join(root, path), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

describe('governed AdSense configuration', () => {
	it('is fail-closed and cannot load or render slots while disabled', () => {
		const environment = {
			ADS_ENABLED: 'false',
			ADSENSE_ARTICLE_INLINE_1_SLOT: '1234567890',
		};

		expect(isAdsEnabled(environment)).toBe(false);
		expect(shouldLoadAdSense(environment, [AD_PLACEMENTS.ARTICLE_INLINE_1])).toBe(false);
		expect(source('src/components/AdSlot.astro')).toContain('isAdsEnabled(env) && slot !== null');

		const wrangler = JSON.parse(source('wrangler.jsonc')) as { vars: Record<string, string> };
		expect(wrangler.vars.ADS_ENABLED).toBe('false');
		expect(wrangler.vars.ADSENSE_ARTICLE_INLINE_1_SLOT).toBe('');
		expect(wrangler.vars.ADSENSE_ARTICLE_INLINE_2_SLOT).toBe('');
		expect(wrangler.vars.ADSENSE_DESKTOP_SIDEBAR_SLOT).toBe('');
	});

	it('loads public ad infrastructure only when enabled with an issued numeric slot', () => {
		const environment = {
			ADS_ENABLED: 'true',
			ADSENSE_ARTICLE_INLINE_1_SLOT: '1234567890',
		};

		expect(getAdSenseSlot(environment, AD_PLACEMENTS.ARTICLE_INLINE_1)).toBe('1234567890');
		expect(shouldLoadAdSense(environment, [AD_PLACEMENTS.ARTICLE_INLINE_1])).toBe(true);
		expect(getAdSenseSlot({ ...environment, ADSENSE_ARTICLE_INLINE_1_SLOT: '' }, AD_PLACEMENTS.ARTICLE_INLINE_1)).toBeNull();
		expect(getAdSenseSlot({ ...environment, ADSENSE_ARTICLE_INLINE_1_SLOT: 'not-issued' }, AD_PLACEMENTS.ARTICLE_INLINE_1)).toBeNull();
	});

	it('uses the official publisher metadata and HTTPS loader once in the public layout', () => {
		const layout = source('src/layouts/SiteLayout.astro');
		expect(ADSENSE_PUBLISHER_ID).toBe('ca-pub-4913684525326701');
		expect(layout).toContain('name="google-adsense-account"');
		expect(layout).toContain('pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=');
		expect(layout.match(/pagead2\.googlesyndication\.com/g)).toHaveLength(1);
		expect(layout).toContain('{loadAdSense && (');
	});

	it('never includes AdSense infrastructure in editorial code', () => {
		for (const path of [join(root, 'src/layouts/EditorialLayout.astro'), ...filesBelow('src/pages/editorial')]) {
			const editorialSource = readFileSync(path, 'utf8');
			expect(editorialSource, path).not.toMatch(/AdSlot|adsbygoogle|googlesyndication|google-adsense-account|ADS_ENABLED/);
		}
	});

	it('serves the authorized seller declaration from the static root', () => {
		expect(ADS_TXT_ENTRY).toBe('google.com, pub-4913684525326701, DIRECT, f08c47fec0942fa0');
		expect(source('public/ads.txt')).toBe(`${ADS_TXT_ENTRY}\n`);
	});
});

describe('restrained article placement policy', () => {
	it('renders no slots for short articles and no more than two for longer articles', () => {
		expect(getArticleInlinePlacements(3)).toEqual([]);
		expect(getArticleInlinePlacements(4)).toEqual([
			{ placement: AD_PLACEMENTS.ARTICLE_INLINE_1, afterParagraph: 2 },
		]);
		expect(getArticleInlinePlacements(6)).toEqual([
			{ placement: AD_PLACEMENTS.ARTICLE_INLINE_1, afterParagraph: 2 },
			{ placement: AD_PLACEMENTS.ARTICLE_INLINE_2, afterParagraph: 5 },
		]);
		expect(getArticleInlinePlacements(100)).toHaveLength(2);
	});

	it('keeps hero, headline, and body ahead of inline ad hooks', () => {
		const story = source('src/pages/story/[slug].astro');
		const hero = story.indexOf('class="article-hero"');
		const header = story.indexOf('class="article-header"');
		const body = story.indexOf('class="article-body"');
		const slot = story.indexOf('<AdSlot placement=');

		expect(hero).toBeGreaterThan(-1);
		expect(hero).toBeLessThan(header);
		expect(header).toBeLessThan(body);
		expect(body).toBeLessThan(slot);
	});
});
