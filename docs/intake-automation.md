# Governed intake automation

The automation subsystem discovers bounded source metadata, creates ordinary source intakes, and generates candidate batches only after the existing normalization review gate has been satisfied. It has no candidate approval, story conversion, or publication capability.

## Authority and execution flow

1. `HttpAutomationSourceProvider` fetches one bounded JSON document from `AUTOMATION_SOURCE_URL`.
2. Each valid source URL receives a deterministic SHA-256 item identity. Existing automation registrations and existing source-reference URLs are checked before intake creation.
3. A new source is persisted as an ordinary `source_intakes` row with its ordinary `source_references` lineage and append-only audit entries. Its suitability is `UNREVIEWED`, scores begin at `1`, and it waits for editorial assessment and normalization acceptance.
4. A later run may process a registered source only when it has an editor-accepted normalized-event version whose suitability is `SUITABLE` and no successful candidate-generation run exists.
5. Candidate generation calls the existing `GenerationService` with the deterministic key `automation:candidates:v1:<normalized-version-id>`. The existing provider limits, daily cost budget, validation, and atomic five-candidate persistence remain authoritative. Every generated candidate is `MODEL`/`DRAFT`.
6. `SENSITIVE` events require the existing manual caution acknowledgement and are not automated. `UNSUITABLE`, `UNREVIEWED`, unnormalized, malformed, duplicate, and already-generated items are explicit no-ops.

The scheduled handler calls `ScheduledController.noRetry()`. The generation service retains its existing bounded provider-attempt behavior, but neither the scheduler nor automation service submits an additional candidate batch after a persisted success or failure. A stale `RUNNING` automation record is closed after 30 minutes; deterministic source and model-run identities make subsequent operator reruns safe.

## Source document contract

The configured endpoint must return JSON shaped as follows:

```json
{
  "items": [
    {
      "title": "Neutral intake title",
      "neutralBrief": "A bounded neutral factual brief supplied by the acquisition system.",
      "sourceTitle": "Original reported headline",
      "sourceUrl": "https://publisher.example/report",
      "publisherName": "Publisher",
      "sourceTier": "TIER_1",
      "sourceType": "STRAIGHT_NEWS",
      "publishedAt": "2026-09-12T12:00:00Z",
      "categoryId": "cat-civic-life"
    }
  ]
}
```

The adapter does not scrape article pages, infer missing metadata, or reinterpret source authority. Invalid records are reported independently as `MALFORMED`. The response is limited to 1,000,000 characters, the request times out after eight seconds, and the configured per-run item cap is applied before processing.

## Operational controls

Checked-in production-safe defaults:

- `AUTOMATION_ENABLED=false`
- `AUTOMATION_SOURCE_URL=` (unconfigured)
- `AUTOMATION_MAX_ITEMS_PER_RUN=3` (valid range 1–20)
- `AUTOMATION_ACTOR_EMAIL=automation@tomorrow-ish.news`
- `triggers.crons=[]`

The proposed production schedule is `0 13 * * 1-5` (13:00 UTC, Monday through Friday). It is documentation only. Activation requires a separate review that changes `triggers.crons` from `[]`, verifies the source endpoint and operational limits, and explicitly deploys that configuration.

## Manual and dry-run operation

Apply migration `0012_governed_intake_automation.sql` only to the intended local or separately approved remote database before using the control page.

Open the Access-protected `/editorial/automation` page. **Run dry-run** fetches and evaluates the source document but performs no D1 or model writes; the no-store JSON response contains item identities, counts, outcomes, and bounded reasons. **Run live automation** uses the same path but remains disabled unless `AUTOMATION_ENABLED=true` and a source URL is configured.

For a local scheduled-handler check after building:

```powershell
npm run build
npx wrangler dev --test-scheduled
Invoke-WebRequest "http://localhost:8787/cdn-cgi/local/scheduled?format=json"
```

With the checked-in settings this returns a disabled no-op and makes no automation writes. Use the protected control page for a source-aware dry-run.

## Observability and failure behavior

`automation_runs` records bounded counts and terminal status for live runs. `automation_run_items` records immutable per-item outcomes and references to any intake, accepted normalized version, and model run. The editorial automation page shows the most recent persisted live run. Dry-runs intentionally do not become persisted “last runs” because their contract is zero writes.

One malformed or failed item does not abort later items. Provider-level discovery failure ends the run as `FAILED`; mixed item results end it as `PARTIAL`. Provider/model diagnostics remain in the existing model-run records, while automation records store bounded classifications rather than raw response bodies or exception text.

Migration, schedule activation, and Worker deployment remain separate reviewed actions. None is automatic.
