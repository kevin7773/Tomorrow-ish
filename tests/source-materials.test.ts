import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const storyPage = readFileSync(join(process.cwd(), 'src/pages/story/[slug].astro'), 'utf8');

describe('published story source materials', () => {
	it('links stored source URLs with a sensible source label', () => {
		expect(storyPage).toContain('<h2 id="source-heading">Source Materials</h2>');
		expect(storyPage).toContain('<a href={source.url} rel="noopener noreferrer">{storySourceLabel(source)}</a>');
	});

	it('distinguishes sourced-event provenance from satirical treatment', () => {
		expect(storyPage).toContain('This article is satire inspired by a real reported event. Details, quotes, characters, and circumstances in the Tomorrow-ish version may be fictionalized.');
	});

	it('shows Purely satire only when the story has no attached sources', () => {
		expect(storyPage).toMatch(/story\.sources\.length \? \([\s\S]*?\) : \([\s\S]*?<strong>Purely satire\.<\/strong>/);
	});

	it('does not fabricate a source URL when none is present', () => {
		expect(storyPage).toContain('source.url.trim()');
		expect(storyPage).toContain(': <span>{storySourceLabel(source)}</span>');
		expect(storyPage).not.toContain('https://example.com');
	});
});
