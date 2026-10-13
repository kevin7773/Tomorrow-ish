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
		REVIEW_NOTIFICATION_EXTERNAL_URL?: string;
		REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN?: string;
		REVIEW_NOTIFICATION_REVIEW_URL?: string;
		RESEND_API_KEY?: string;
		RESEND_WEBHOOK_SIGNING_SECRET?: string;
		EDITORIAL_NOTIFICATION_TO_EMAIL?: string;
		EDITORIAL_NOTIFICATION_FROM_EMAIL?: string;
		EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED?: string;
		EDITORIAL_AUTOMATED_PUBLICATION_ENABLED?: string;
		EDITORIAL_WORKFLOW_GENERATION_ENABLED?: string;
		EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED?: string;
		MODEL_BATCH_BUDGET_MICRO_USD?: string;
		IMAGE_ATTEMPT_BUDGET_MICRO_USD?: string;
		IMAGE_BATCH_BUDGET_MICRO_USD?: string;
		IMAGE_DAILY_BUDGET_MICRO_USD?: string;
		EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE?: string;
		EDITORIAL_WORKFLOW_SMOKE_BATCH_ID?: string;
		EDITORIAL_WORKFLOW_SMOKE_INTAKE_ID?: string;
		EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY?: string;
	}
}
