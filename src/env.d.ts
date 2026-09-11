/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />
type Runtime = import('@astrojs/cloudflare').Runtime;

interface EditorialIdentity {
	email: string;
}

declare namespace App {
	interface Locals extends Runtime {
		editor?: EditorialIdentity;
		csrfToken?: string;
	}
}

declare namespace Cloudflare {
	interface Env {
		CLOUDFLARE_AI_API_TOKEN: string;
		IMAGE_WEBHOOK_SECRET: string;
		IMAGE_WEBHOOK_ORIGIN: string;
	}
}
