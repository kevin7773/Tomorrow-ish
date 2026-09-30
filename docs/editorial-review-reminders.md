# Editorial review reminders

Editorial reminders track the two human-action phases of the batch workflow. They do not generate, edit, reject, approve, or publish content.

## Durable model

- The existing `automation_runs.id` is the editorial batch ID. It groups the intakes created by one normal acquisition run before any model run exists.
- `editorial_batch_items.workflow_state` is the reminder source of truth. `INGESTED` is pending for `TRIAGE`; `READY_FOR_REVIEW` is pending for `FINAL_REVIEW`.
- Selecting or rejecting every intake resolves triage. The final phase is created only after selected work has left active generation and at least one article is ready.
- Editing copy or regenerating an image leaves the item `READY_FOR_REVIEW`. Only explicit `PUBLISHED` or `REJECTED` outcomes resolve an article's final-review work.
- `editorial_stage_reminders` has one row per batch and phase. Each row owns its own initial, six-hour, final, resolution, and claim timestamps; final review never inherits triage timing.
- `editorial_workflow_events` is append-only and retains batch, transition, reminder, and bounded failure events without article bodies or secrets.

## Delivery and retry safety

The five-minute Cron first advances durable automatic generation and then polls reminders. For each phase, the service sends an initial notification, one follow-up approximately six hours after the initial send, and one final follow-up approximately 24 hours after the initial send. It sends nothing further after resolution.

A D1 claim lease prevents concurrent processors from sending the same notification. Provider calls use `Idempotency-Key: editorial-review:<batch-id>:<phase>:<kind>`. A Worker restart therefore resumes persisted state, while an ambiguous response is deduplicated by the receiver. A notification failure releases only the reminder claim, records a bounded classification, and never changes intake, generation, image, story, or publication state.

Initial wording is count-aware:

- `📰 Tomorrow-ish has 3 new intakes ready for editorial triage.`
- `📰 Tomorrow-ish has 2 finished stories ready for final editorial review.`

## Sender contract

`WebhookReviewNotifier` makes one `POST` request with no explicit application timeout and no transport-level retry. It sends `Content-Type: application/json` and the idempotency header above. Any HTTP 2xx response is success. A network error or non-2xx response is reported to the reminder service, which releases only that reminder claim; the next five-minute poll may try the same idempotency key again.

The exact JSON body is:

```json
{
  "text": "Tomorrow-ish has 1 new intake ready for editorial triage.",
  "reviewUrl": "https://tomorrow-ish.news/editorial/batches/<batch-id>/triage",
  "batchId": "<batch-id>",
  "reminderStage": "TRIAGE",
  "reminderKind": "INITIAL"
}
```

`reminderStage` is `TRIAGE` or `FINAL_REVIEW`; `reminderKind` is `INITIAL`, `SIX_HOUR`, or `FINAL`; and `reviewUrl` may be `null` only when no review origin is configured.

## Internal receiver and delivery

The checked-in receiver is `POST /api/internal/review-notifications`. `REVIEW_NOTIFICATION_WEBHOOK_URL` points to that same-worker URL as a non-secret runtime variable. `REVIEW_NOTIFICATION_REVIEW_URL` remains optional; the review origin defaults to `IMAGE_WEBHOOK_ORIGIN`.

The endpoint accepts only the exact sender schema, exact same-origin review route, and exact idempotency key. A new receipt is authorized only while the matching `editorial_stage_reminders` row owns an active claim for that phase and reminder kind. Previously delivered exact duplicates return HTTP 200 without producing another notification; conflicting payload reuse is rejected.

`review_notification_receipts` records bounded delivery state, attempts, timestamps, and failure classifications. `editorial_notifications` is the first-party human-visible destination and contains at most one row per idempotency key. Kevin can view the durable inbox at `/editorial/notifications` inside the existing protected editorial workspace. No additional provider, account, or secret is required.

Migration `0014_editorial_review_reminders.sql` creates the batch, batch-item, phase-reminder, append-only event, receipt, and internal-notification tables. It has not been applied by deployment and must be reviewed and applied as a separate operator action before this code is deployed.
