# Governed article-body generation

Tomorrow-ish keeps alternative selection and article writing as separate governed operations:

```text
Source
  -> generate five alternatives
  -> choose one DRAFT candidate
  -> generate one article body
  -> human edit
  -> REVIEW
  -> APPROVED
  -> image generation and review
  -> publish
```

Alternative generation continues to produce only headline, deck, rationale, and satirical mechanism fields. An authenticated editor may explicitly request a body for one selected candidate only when it remains `DRAFT`, has no existing body, has a reviewed source assessment, and points to an accepted normalized-event version with authoritative factual support. `MODEL_GENERATION_ENABLED` controls both newsroom model operations; article-body generation is independent from `IMAGE_GENERATION_ENABLED`.

The body provider receives persisted source and governance data rather than browser-submitted copies: source metadata and references, the neutral brief, reviewed scores and suitability, guardrail flags, the accepted normalized assertions and their source links, the selected candidate framing, category, and persisted editorial caution reason. A sensitive source requires a non-empty persisted caution reason. Unresolved allegations remain marked as such, and the prompt requires attribution, no assertion of guilt, no fabricated quotations or motives, and no intensification beyond the factual substrate.

## Submission and concurrency

Migration `0010_governed_article_body_generation.sql` adds an append-only body-run history plus a candidate-level generation state and run pointer. Before contacting the provider, the repository atomically creates one `PENDING` run and claims the still-empty DRAFT candidate. A unique partial index prevents another pending run for the same candidate. The provider is invoked once; this operation has no automatic retry.

Successful validated output is four to seven Markdown prose paragraphs plus bounded review metadata. Completion writes only `draft_body_markdown`, generation state, editor/timestamp fields, terminal run metadata, and append-only audit records. It does not change headline, deck, category, source provenance, or candidate status. If a human body appears while the provider is running, the conditional completion fails, records `CONCURRENT_EDIT`, and preserves the human copy.

Provider, validation, or persistence failure leaves the body and DRAFT status unchanged, records a safe terminal failure, and requires a new explicit editor action to retry. Existing non-empty bodies never expose the initial-generation action and are never overwritten.

If a Worker interruption leaves a run `PENDING`, an authenticated editor may use **Resolve stale request** after one hour. The server atomically marks that same run `FAILED` with `STALE_PENDING`, releases the candidate claim, and appends an audit event. Resolution never constructs or calls the provider, never retries, and never submits a replacement request; any later retry remains a separate explicit editor action.

## Production setup

1. Keep `MODEL_GENERATION_ENABLED` at its reviewed value and do not couple it to image generation.
2. Review and apply migration `0010_governed_article_body_generation.sql` to the intended D1 database.
3. Deploy the matching code only after the migration is confirmed.
4. Open an eligible empty-body DRAFT candidate and confirm the **Generate article body** control accurately reflects model availability.
5. For a first paid test, submit once, confirm the run moves from `PENDING` to `SUCCEEDED` or `FAILED`, and verify the candidate remains DRAFT.

No production migration, deployment, provider request, review transition, image action, approval, or publication is automatic.
