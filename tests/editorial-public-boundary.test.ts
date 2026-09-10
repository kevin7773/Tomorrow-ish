import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const publicRoutes = [
	'src/pages/index.astro',
	'src/pages/latest.astro',
	'src/pages/archive.astro',
	'src/pages/story/[slug].astro',
	'src/pages/sitemap.xml.ts',
];

describe('editorial/public route separation', () => {
	it('does not import the editorial repository from any public data route', () => {
		for (const route of publicRoutes) {
			const source = readFileSync(join(process.cwd(), route), 'utf8');
			expect(source, route).not.toMatch(/editorial-repository|runtime-editorial/);
			expect(source, route).not.toMatch(/source_intakes|source_references|satire_candidates/);
		}
	});
});
