import { describe, expect, it } from 'vitest';
import { absoluteSiteUrl, buildPageMetadata, serializeJsonLd } from '../src/lib/metadata';

describe('canonical and social metadata', () => {
	it('always resolves paths against the canonical .news hostname', () => {
		expect(absoluteSiteUrl('/story/a-future-story')).toBe(
			'https://tomorrow-ish.news/story/a-future-story',
		);
	});

	it('builds article metadata without inventing an image', () => {
		const metadata = buildPageMetadata({
			title: 'A Fictional Headline',
			description: 'Clearly fictional.',
			canonicalPath: '/story/fictional',
			type: 'article',
		});

		expect(metadata.title).toBe('A Fictional Headline | Tomorrow-ish');
		expect(metadata.openGraphType).toBe('article');
		expect(metadata.imageUrl).toBeUndefined();
	});

	it('escapes markup-significant characters in JSON-LD', () => {
		expect(serializeJsonLd({ headline: '</script>' })).not.toContain('</script>');
		expect(serializeJsonLd({ headline: '</script>' })).toContain('\\u003c/script>');
	});
});
