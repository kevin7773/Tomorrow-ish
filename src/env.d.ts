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
		REVIEW_NOTIFICATION_WEBHOOK_URL?: string;
		REVIEW_NOTIFICATION_REVIEW_URL?: string;
		EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED?: string;
		EDITORIAL_AUTOMATED_PUBLICATION_ENABLED?: string;
		EDITORIAL_WORKFLOW_GENERATION_ENABLED?: string;
		EDITORIAL_WORKFLOW_SMOKE_BATCH_ID?: string;
		EDITORIAL_WORKFLOW_SMOKE_INTAKE_ID?: string;
		EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY?: string;
	}
}
