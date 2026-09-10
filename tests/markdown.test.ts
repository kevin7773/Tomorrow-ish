import { describe, expect, it } from 'vitest';
import { renderStoryMarkdown } from '../src/lib/markdown';

describe('story Markdown rendering', () => {
	it('renders editorial blocks and inline emphasis', () => {
		const html = renderStoryMarkdown('Opening **statement**.\n\n## Details\n\n- One\n- Two');

		expect(html).toContain('<p>Opening <strong>statement</strong>.</p>');
		expect(html).toContain('<h2>Details</h2>');
		expect(html).toContain('<ul>\n<li>One</li>\n<li>Two</li>\n</ul>');
	});

	it('escapes raw HTML and refuses unsafe link schemes', () => {
		const html = renderStoryMarkdown('<script>alert(1)</script> [bad](javascript:alert(1))');

		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).not.toContain('<script>');
		expect(html).not.toContain('href=');
	});
});
