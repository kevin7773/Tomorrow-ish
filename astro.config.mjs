// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
	adapter: cloudflare({ imageService: 'compile' }),
	output: 'server',
	site: 'https://tomorrow-ish.news',
	trailingSlash: 'never',
	// Preserve Astro 6's HTML whitespace behavior during the v7 migration.
	compressHTML: true,
	// M0 has no sessions. Keep the session runtime and KV binding out of the Worker.
	session: false,
});
