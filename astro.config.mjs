// @ts-check
import { defineConfig, sessionDrivers } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
	adapter: cloudflare({ imageService: 'compile' }),
	output: 'server',
	site: 'https://tomorrow-ish.news',
	trailingSlash: 'never',
	// M0 has no sessions. This prevents the adapter from provisioning an unused KV namespace.
	session: {
		driver: sessionDrivers.lruCache(),
	},
});
