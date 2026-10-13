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

The scheduled Worker uses `InternalReviewNotifier` to pass the same logical contract directly to the receiver service in-process. It does not fetch the Worker's own public hostname. Durable acceptance or an exact previously delivered duplicate is success. Any other result is reported to the reminder service, which releases only that reminder claim; the next five-minute poll may try the same idempotency key again.

`WebhookReviewNotifier` is the external adapter. It makes one `POST` request with an eight-second timeout and no transport-level retry. It requires an HTTPS destination and a bearer secret of at least 32 characters. It sends `Authorization: Bearer <secret>`, `Content-Type: application/json`, and the idempotency header above.

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

HTTP 200 is confirmed delivery only when the JSON acknowledgement is exactly compatible with:

```json
{
  "deliveryState": "DELIVERED",
  "idempotencyKey": "editorial-review:<batch-id>:<phase>:<kind>",
  "deliveryId": "optional-destination-reference"
}
```

HTTP 202, other successful statuses, malformed or mismatched acknowledgements, timeouts, network loss, and HTTP 5xx responses are ambiguous. HTTP 4xx is a definitive rejection. No uncertain or failed delivery is retried automatically.

`reminderStage` is `TRIAGE` or `FINAL_REVIEW`; `reminderKind` is `INITIAL`, `SIX_HOUR`, or `FINAL`; and `reviewUrl` may be `null` only when no review origin is configured.

## Internal receiver and delivery

The checked-in receiver is `POST /api/internal/review-notifications`. The endpoint and scheduled internal sender share the same validation, receipt, and inbox-delivery services. `REVIEW_NOTIFICATION_WEBHOOK_URL` remains a non-secret compatibility value for that internal endpoint and is not an external notification destination. External delivery uses the separately reviewed `REVIEW_NOTIFICATION_EXTERNAL_URL` and secret `REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN`. `REVIEW_NOTIFICATION_REVIEW_URL` remains optional; the review origin defaults to `IMAGE_WEBHOOK_ORIGIN`.

The endpoint accepts only the exact sender schema, exact same-origin review route, and exact idempotency key. A new receipt is authorized only while the matching `editorial_stage_reminders` row owns an active claim for that phase and reminder kind. Previously delivered exact duplicates return HTTP 200 without producing another notification; conflicting payload reuse is rejected.

`review_notification_receipts` records bounded delivery state, attempts, timestamps, and failure classifications. `editorial_notifications` is the first-party human-visible destination and contains at most one row per idempotency key. Kevin can view the durable inbox at `/editorial/notifications` inside the existing protected editorial workspace. No additional provider, account, or secret is required.

Migration `0014_editorial_review_reminders.sql` creates the batch, batch-item, phase-reminder, append-only event, receipt, and internal-notification tables. Migration `0021_notification_delivery_and_automated_publication.sql` adds durable external delivery attempts. Migration `0022_operational_admission_and_notification_reconciliation.sql` adds append-only operator reconciliation evidence.

## Operator reconciliation

The protected notification inbox lists `FAILED` and `AMBIGUOUS` external attempts. An operator first searches the actual destination by the persisted idempotency key:

- If a matching delivered message exists, record `CONFIRMED_DELIVERED` with the destination evidence reference.
- If the destination can definitively prove it did not accept or deliver the request, record `CONFIRMED_FAILED`.
- A definitively failed message may be sent manually using the original idempotency key, then recorded as `MANUALLY_DELIVERED`; the evidence must include that key.
- If the destination cannot establish the outcome, leave the row `AMBIGUOUS`. Do not send again.

Reconciliation never invokes the webhook. Its actor, timestamp, decision, and evidence reference are immutable. Secrets are Worker secrets, never D1 fields, request payload fields, logs, or UI values.
