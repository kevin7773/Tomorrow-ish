# Governed article-image generation

Article images are an ancillary editorial subsystem. They cannot publish a story, change story copy, or bypass the existing `DRAFT → REVIEW → APPROVED → PUBLISHED` lifecycle. Publication without an image remains valid.

## Architecture and authority

The subsystem has four replaceable boundaries:

- `ImageProvider` accepts a prompt, aspect ratio, and provider options and returns provider/model provenance plus downloaded image bytes.
- `ReplicateFluxProvider` is the initial adapter. Article-domain and editorial code do not import Replicate-specific types.
- `ImageAssetStore` durably copies bytes into the `IMAGE_ASSETS` R2 bucket before D1 records a successful generation.
- `ArticleImageRepository` records append-only generation history and performs explicit review transitions.

Only an authenticated editor viewing a story whose authoritative status is `APPROVED` can initiate a paid request. The button creates exactly one request; there is no automatic retry, polling loop, scheduled generation, or generation-on-draft behavior. A provider failure records a `GENERATION_FAILED` history row when a provider request was attempted and leaves the story unchanged.

## Prompt production

`produceArticleImagePrompt()` derives a concise central visual concept from final story fields (headline, deck or social excerpt, and category). It does not copy the full article body or fetch sources. Every prompt includes the Tomorrow-ish house direction and explicitly requests illustration rather than documentary evidence of a fabricated event.

The current prompt version is `tomorrow-ish-editorial-v1`. The exact submitted prompt and version are immutable provenance.

## Image lifecycle

Successful images begin as `GENERATED` and cannot appear publicly. An editor can:

- approve a generated image after reviewing/editing mandatory descriptive alt text;
- reject it without deleting its asset or provenance;
- mark an unapproved image `REGENERATE_REQUESTED`, then separately press the paid generation button when ready.

Other recorded outcomes are `APPROVED`, `REJECTED`, and `GENERATION_FAILED`. Approval atomically changes the image status and assigns its immutable asset key to the story's single `stories.og_image_key` current-hero pointer. Multiple historical rows may remain `APPROVED`, but exactly one can function as the current/public hero because the story has only one pointer; the editorial UI labels that row `CURRENT HERO`. Current approved images cannot be rejected or marked for regeneration. Approving a later generated image moves the single pointer to that image without deleting or relabeling the previous approved provenance row. The public `/media/...` route serves an R2 object only while a currently `PUBLISHED` story still points to that exact key; prior publication or prior association is insufficient. Editorial previews use the Access-protected `/editorial/media/...` route.

## Replicate and FLUX

The default model is the current official Replicate model identifier `black-forest-labs/flux-2-pro`. The adapter calls the official-model endpoint and requests one 16:9 WebP at quality 90 with the provider safety tolerance set to 2. It uses one bounded synchronous wait and a 60-second provider cancellation deadline; an incomplete response fails cleanly and requires an editor-triggered retry.

Replicate deletes API output files after one hour, so the adapter downloads the returned image during the request and the service writes it to R2 before successful provenance is committed. Temporary `replicate.delivery` URLs are never stored as article assets.

Official references:

- [FLUX 2 Pro API schema](https://replicate.com/black-forest-labs/flux-2-pro/api/schema)
- [Creating predictions with official models](https://replicate.com/docs/topics/predictions/create-a-prediction)
- [Replicate output-file retention](https://replicate.com/docs/topics/predictions/output-files)

## Required configuration and manual setup

`wrangler.jsonc` contains only replaceable, non-secret settings and the R2 binding:

```text
IMAGE_PROVIDER=replicate
IMAGE_MODEL=black-forest-labs/flux-2-pro
IMAGE_GENERATION_ENABLED=false
IMAGE_ASSETS -> tomorrow-ish-images
```

Do not enable or deploy this subsystem until the following separately reviewed operator actions are authorized:

1. Review and apply `migrations/0005_governed_article_images.sql` to the intended D1 database. Deployment never applies it automatically.
2. Create the R2 bucket named `tomorrow-ish-images` (or change the reviewed binding configuration to the chosen bucket). This repository does not provision it.
3. Create the production runtime secret interactively with `npx wrangler secret put REPLICATE_API_TOKEN`. Never place the token in source, command output, or committed configuration. Local testing may use an ignored `.dev.vars` file.
4. Change only `IMAGE_GENERATION_ENABLED` to `true`, rerun `npm run types`, and complete the normal validation/deployment review.

For local end-to-end UI testing, use an explicitly disposable local/test provider setup and keep its token only in ignored local environment configuration; automated tests inject mocks and never call Replicate.

## Adding another provider

Implement `ImageProvider`, return normalized `GeneratedImage` bytes and provenance, and extend the runtime factory's provider selection. Do not change story states, the D1 image lifecycle, asset storage, approval behavior, or publication service. Provider-specific input options belong inside the adapter or the optional provider-options field, not in article-domain records.
