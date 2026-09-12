# Governed article-image generation

Article images are an ancillary editorial subsystem. They cannot publish a story, change story copy, or bypass the existing `DRAFT → REVIEW → APPROVED → PUBLISHED` lifecycle. Publication without an image remains valid.

## Architecture and authority

The subsystem has four replaceable boundaries:

- `ImageProvider` is a discriminated synchronous/asynchronous provider union. Synchronous providers return validated bytes; asynchronous providers return acceptance with an optional provider request ID and complete through the webhook service.
- `CloudflareGatewayImageProvider` is the active asynchronous adapter. `OpenAIImageProvider` and `ReplicateFluxProvider` remain available synchronous adapters. Article-domain and editorial code do not import provider-specific types.
- `ImageAssetStore` durably copies bytes into the `IMAGE_ASSETS` R2 bucket before D1 records a successful generation.
- `ArticleImageRepository` records append-only generation history and performs explicit review transitions.

Only an authenticated editor viewing a story whose authoritative status is `APPROVED` can initiate a paid request. The button creates exactly one request; there is no automatic retry, polling loop, scheduled generation, or generation-on-draft behavior. A partial unique D1 index permits at most one `PENDING` row per story. A provider failure records a `GENERATION_FAILED` history row and leaves the story unchanged.

## Prompt production

`produceArticleImagePrompt()` derives a concise central visual concept from reader-facing story fields. It prefers a concrete deck, social excerpt, or opening body sentence, but excludes editorial lifecycle and test scaffolding; when no safe supporting detail remains, it requests a literal visual interpretation of the headline in the story's category setting. An internal-only headline fails closed instead of becoming provider input. For stories originating from a `SENSITIVE` intake or carrying `UNRESOLVED_ALLEGATION`, the service instead loads the persisted candidate caution direction and satirical mechanism. That governed direction becomes the visual concept, while source allegations remain background-only and the prompt requires anonymous or symbolic, fully clothed subjects rather than an identifiable person or reconstruction. Missing sensitive-source caution fails closed. The builder does not copy the full article body or fetch sources. Every prompt includes the Tomorrow-ish house direction and explicitly requests illustration rather than documentary evidence of a fabricated event.

The current prompt version is `tomorrow-ish-editorial-v3`. The exact submitted prompt and version are immutable provenance.

## Image lifecycle

The asynchronous lifecycle is `PENDING → GENERATED` or `PENDING → GENERATION_FAILED`. `PENDING` means the provider accepted the request but no reviewable asset exists. It is never treated as successful, cannot be approved, and blocks another paid generation for the same story. On completion, successful images become `GENERATED` and still cannot appear publicly. An editor can:

- approve a generated image after reviewing/editing mandatory descriptive alt text;
- reject it without deleting its asset or provenance;
- mark an unapproved image `REGENERATE_REQUESTED`, then separately press the paid generation button when ready.

Other recorded outcomes are `APPROVED`, `REJECTED`, and `GENERATION_FAILED`. Approval atomically changes the image status and assigns its immutable asset key to the story's single `stories.og_image_key` current-hero pointer. Multiple historical rows may remain `APPROVED`, but exactly one can function as the current/public hero because the story has only one pointer; the editorial UI labels that row `CURRENT HERO`. Current approved images cannot be rejected or marked for regeneration. Approving a later generated image moves the single pointer to that image without deleting or relabeling the previous approved provenance row. The public `/media/...` route serves an R2 object only while a currently `PUBLISHED` story still points to that exact key; prior publication or prior association is insufficient. Editorial previews use the Access-protected `/editorial/media/...` route.

## Cloudflare AI Gateway background provider

The active adapter submits one background REST request to `POST /client/v4/accounts/{account_id}/ai/run` with `model=openai/gpt-image-2`, `options.background=true`, and a per-image webhook URL. It sends one medium-quality, opaque, 1536×1024 WebP—the closest currently supported landscape size to the site's 16:9 hero format. Cloudflare documents that a background request returns immediately and later delivers the result to the webhook, but does not document an initial success-body schema or guarantee that the initial response contains a run ID. A non-2xx response or an explicit Cloudflare failure envelope is rejection; a 2xx response is retained as an accepted `PENDING` request even when its response body is absent, unreadable, or has no run ID, because the provider may already be running. Provider acceptance is not generation success. The request overrides any Gateway retry default with `cf-aig-max-attempts: 1`, so the Gateway cannot turn one editorial action into multiple upstream attempts.

Cloudflare's current background/webhook contract is documented on the REST API, while the Workers AI binding documents ordinary `env.AI.run()` calls but does not expose the background webhook options in its binding contract. This implementation therefore uses the authenticated Cloudflare REST endpoint from the Worker and does not add an unused `AI` binding.

Cloudflare documents webhook delivery as best-effort with no retries and does not document a callback-signature header. Each request therefore receives a unique HTTPS capability URL containing an HMAC-SHA-256 signature derived from `IMAGE_WEBHOOK_SECRET` and the locally generated image ID. The endpoint verifies that signature before parsing a bounded body. The submission sets `cf-aig-collect-log-payload: false`, retaining Gateway metrics while preventing the prompt and capability-bearing `webhookUrl` request body from being stored in Gateway logs. The capability URL and signing secret must not be logged elsewhere. Cloudflare's callback `story`, model, provider, object-key, and alt-text values are never authoritative: the persisted pending record supplies those values.

The first valid terminal callback wins. The webhook inbox has one row per image and unique provider request ID; duplicate delivery is idempotent, contradictory later success/failure callbacks cannot overwrite a terminal image, and unknown or mismatched IDs are rejected. The per-image HMAC capability URL securely identifies the persisted pending image without trusting callback story/model fields. When the initial 2xx response has no run ID, the first authenticated callback supplies the provider run ID, which is atomically attached before completion processing. The same path safely handles a callback that beats submission-response processing. Completion claims the inbox row with a compare-and-set before downloading. It accepts only HTTPS Cloudflare R2 delivery hosts with a DNS-label boundary before `.r2.dev` or `.r2.cloudflarestorage.com`; the latter is Cloudflare's documented S3-compatible/presigned-object host family and is also used by AI Gateway output delivery. Bare suffixes, general `cloudflarestorage.com` hosts, lookalike suffixes, credentials, explicit ports, alternate schemes, and redirects remain fail-closed. The response must be a bounded WebP of at most 12 MiB with a valid signature and the expected 1536×1024 dimensions. The deterministic R2 key comes only from persisted internal story/image IDs. A temporary provider result URL is retained only while an authenticated success callback is recoverable in `RECEIVED` or `PROCESSING`; the atomic transition to `PROCESSED` clears it, including after terminal failure. Provider request ID, bounded callback metadata, safe failure details, timestamps, and state remain for audit and idempotency. Migration `0008` also scrubs result URLs from historical processed inbox rows. If D1 completion fails after the R2 write, the service compensates by deleting the object.

Failure callbacks store only bounded classifications/codes and provenance—not response bodies or raw exception messages—and never retry. Unexpected processing errors release the webhook inbox claim back to `RECEIVED` after compensating R2 cleanup, making the same already-delivered callback manually recoverable without another provider request.

For a `PENDING` row older than one hour, an authenticated editor uses **Resolve stale request** on that story's image-history record. The action never constructs or invokes an image provider. If an early callback is waiting in `RECEIVED`, it restores the callback's run-ID mapping and processes that stored result. If no callback exists, or a crashed worker left its callback claimed as `PROCESSING`, it transitions the same image row to `GENERATION_FAILED` with `STALE_PENDING`, marks that inbox entry processed, records the acting editor in the audit log, preserves the original prompt and provenance, and releases the per-story pending lock. It does not reset a claimed callback and race a potentially live completion worker; that worker's D1 compare-and-set will fail and any object it wrote will be removed. A later callback cannot resurrect the terminal failure. This is the deliberate recovery procedure for crashes after pending persistence, provider acceptance before run-ID attachment, completion processing, and best-effort callback loss; there is no timer, deletion, automatic retry, or automatic resubmission.

Official Cloudflare references:

- [AI REST API, background requests, and webhook payload](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [Cloudflare GPT Image 2 model contract](https://developers.cloudflare.com/ai/models/openai/gpt-image-2/)
- [AI Gateway BYOK stored keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [AI Gateway Unified Billing and credential precedence](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- [AI Gateway request retries and per-request overrides](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)
- [AI Gateway payload logging control](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [R2 presigned URL host format](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 managed public `r2.dev` domains](https://developers.cloudflare.com/r2/buckets/public-buckets/)

## Retained direct OpenAI Images provider

The retained direct adapter uses `gpt-image-2`. It calls `POST /v1/images/generations`, requests one opaque 1536×864 WebP for the existing 16:9 workflow, and receives the result as base64 image data. It validates the response size, declared output format, base64 encoding, and WebP signature before returning bytes to the service. Only bounded, non-sensitive response metadata is persisted; provider error bodies and credentials are not retained.

The generated bytes continue through the existing `ImageAssetStore` boundary: R2 persistence must succeed before D1 records a successful generation. The adapter performs no automatic retry, and `IMAGE_GENERATION_ENABLED=false` still blocks the request before either provider can be constructed.

Official OpenAI references:

- [Create image API](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [GPT Image 2 model](https://developers.openai.com/api/docs/models/gpt-image-2)

## Retained Replicate provider

The default model is the current official Replicate model identifier `black-forest-labs/flux-2-pro`. The adapter calls the official-model endpoint and requests one 16:9 WebP at quality 90 with the provider safety tolerance set to 2. It uses one bounded synchronous wait and a 60-second provider cancellation deadline; an incomplete response fails cleanly and requires an editor-triggered retry.

Replicate deletes API output files after one hour, so the adapter downloads the returned image during the request and the service writes it to R2 before successful provenance is committed. Temporary `replicate.delivery` URLs are never stored as article assets.

Official references:

- [FLUX 2 Pro API schema](https://replicate.com/black-forest-labs/flux-2-pro/api/schema)
- [Creating predictions with official models](https://replicate.com/docs/topics/predictions/create-a-prediction)
- [Replicate output-file retention](https://replicate.com/docs/topics/predictions/output-files)

## Required configuration and manual setup

`wrangler.jsonc` contains only replaceable, non-secret settings and the R2 binding:

```text
IMAGE_PROVIDER=cloudflare-ai-gateway
IMAGE_MODEL=openai/gpt-image-2
IMAGE_GENERATION_ENABLED=false
CLOUDFLARE_ACCOUNT_ID=<account-id>
CLOUDFLARE_AI_GATEWAY_ID=tomorrow-ish
IMAGE_WEBHOOK_ORIGIN=https://tomorrow-ish.news
IMAGE_ASSETS -> tomorrow-ish-images
```

Two Worker secrets are required but never committed: `CLOUDFLARE_AI_API_TOKEN`, with Account > Workers AI > Read permission, and a strong random `IMAGE_WEBHOOK_SECRET`. Cloudflare's endpoint-specific REST documentation classifies third-party `/ai/run` traffic, including `openai/gpt-image-2`, under Unified Billing and advises loading sufficient credits. Its general credential-precedence documentation also says a stored provider key under the `default` BYOK alias is consulted before Unified Billing on unified endpoints; non-default aliases apply only to provider-native passthrough. Consequently, this adapter never transmits a provider key, but a correctly configured default stored key may be selected by Cloudflare; otherwise prepaid credits are required. The existing Worker `OPENAI_API_KEY` is used only by the retained direct OpenAI provider. Before enablement, an operator must verify the default-alias key path or fund Unified Billing and configure an AI Gateway spend limit. Unified Billing currently adds a 5% credit-purchase fee while passing provider inference prices through without markup.

Do not enable or deploy this subsystem until the following separately reviewed operator actions are authorized:

1. Review and apply `migrations/0007_async_article_images.sql` and `migrations/0008_scrub_image_webhook_result_urls.sql` to the intended D1 database in order after confirming migrations `0001`–`0006` are already applied. Deployment never applies them automatically. Migration `0007` copies existing image rows—including historical failures—without changing their provenance; migration `0008` preserves normalized webhook audit fields while clearing temporary result URLs from already-processed callbacks.
2. Confirm the `tomorrow-ish-images` R2 bucket and `IMAGE_ASSETS` binding still match the reviewed configuration.
3. Create or select the AI Gateway named by `CLOUDFLARE_AI_GATEWAY_ID`. Verify that its OpenAI key is stored under the `default` BYOK alias, or fund sufficient Unified Billing credits for third-party `/ai/run` requests; configure the intended spend limit either way. A non-default BYOK alias is not selected by this endpoint.
4. Create a narrowly scoped Cloudflare API token with Account > Workers AI > Read permission and enter it interactively with `npx wrangler secret put CLOUDFLARE_AI_API_TOKEN`. Never place it in command history or source.
5. Generate a strong independent signing secret of at least 32 bytes and enter it interactively with `npx wrangler secret put IMAGE_WEBHOOK_SECRET`. Do not reuse the Cloudflare or OpenAI credential.
6. Deploy once with `IMAGE_GENERATION_ENABLED=false`, verify the webhook route rejects missing/invalid signatures, and smoke-test editorial/public image boundaries. No model request is required for this check.
7. For a later controlled paid smoke test, select one `APPROVED` story, inspect its final prompt/alt text, set only `IMAGE_GENERATION_ENABLED=true`, deploy, submit exactly once, and stop. Verify `PENDING` first, then one authenticated callback, one `GENERATED` row, one R2 object, unchanged story status/`og_image_key`, protected preview access, and public denial. Return the flag to `false` afterward. Never approve or retry automatically.

The webhook path must remain internet-reachable over HTTPS so Cloudflare can deliver it. If a broader Cloudflare Access application covers the whole hostname, configure a narrowly scoped bypass for `/api/image-generation/webhook/*`; the HMAC capability is the route's authentication control. Keep the editorial Access policy unchanged.

For local end-to-end UI testing, use an explicitly disposable local/test provider setup and keep its token only in ignored local environment configuration; automated tests inject mocks and never call Cloudflare, OpenAI, or Replicate.

## Adding another provider

Implement either `SynchronousImageProvider` (normalized `GeneratedImage` bytes) or `AsynchronousImageProvider` (accepted submission provenance with an optional immediate provider request ID), then extend the runtime factory. Asynchronous implementations must use the existing pending/webhook completion service rather than reporting acceptance as success. Do not change story states, approval behavior, or publication authority.
