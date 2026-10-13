# Resend editorial email delivery

This integration extends the existing D1-backed editorial reminder service. It does not create a scheduler, approve content, publish stories, or expose drafts. The existing five-minute Cron remains the only reminder scheduler and continues to own the initial, six-hour, and 24-hour cadence.

External email is disabled unless `EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED=true`. A disabled deployment may install migration `0024_resend_editorial_notifications.sql` and the Worker routes without configuring provider secrets or sending email.

## Delivery contract

1. The existing reminder service claims the logical notification and writes the first-party notification inbox.
2. `DurableExternalReviewNotifier` inserts exactly one `external_review_notification_deliveries` operation before calling the external HTTPS adapter.
3. The adapter authenticates the request with `REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN`, validates the exact notification idempotency key, and inserts one `resend_email_submissions` reservation before provider construction.
4. The Resend API request uses the original editorial idempotency key as its `Idempotency-Key`. D1 remains the durable deduplication authority; Resend's provider-side retention is only a secondary safeguard.
5. A successful Resend submission returns HTTP 202 to the source adapter:

```json
{
  "deliveryState": "PENDING",
  "idempotencyKey": "editorial-review:<batch>:<stage>:<kind>",
  "deliveryId": "<Resend email ID>",
  "classification": null
}
```

HTTP 200/202 from Resend is provider acceptance, not delivery. Both D1 ledgers remain `PENDING`; the reminder's sent timestamp is not completed.

6. Resend sends a signed event to `/api/internal/resend-delivery-webhook`. The Worker verifies the raw body using the Svix ID, timestamp, and signature headers, enforces a five-minute replay window, verifies the configured recipient, and matches the provider email ID to the original reservation.
7. Only `email.delivered` changes both the destination reservation and source external operation to `DELIVERED`. `email.failed`, `email.bounced`, and `email.suppressed` produce `FAILED`. `email.delivery_delayed` is immutable evidence but remains `PENDING`.
8. Duplicate events are idempotent. Contradictory events arriving after a terminal outcome are retained as `IGNORED_TERMINAL` evidence and cannot replace the first terminal result.
9. Network loss, timeout, malformed success, or accepted-request persistence uncertainty becomes `AMBIGUOUS`. No `PENDING` or `AMBIGUOUS` request is automatically submitted again.
10. On the next five-minute reminder pass, an already confirmed `DELIVERED` operation completes the existing reminder claim without another Resend request. Six-hour and 24-hour timing therefore begins from confirmed delivery rather than queue acceptance.

## Email contents

The sender is exactly `editorial@tomorrow-ish.news`. The recipient is the server-configured Gmail address. Email contains only Tomorrow-ish branding, batch ID, pending count, reminder stage, and the fixed protected-dashboard link `https://tomorrow-ish.news/editorial`. It never contains draft headlines, article text, image prompts, cookies, Access assertions, API keys, or authentication links.

Subjects are:

- initial final review: `Tomorrow-ish: 3 Articles Awaiting Review` (count-aware);
- six-hour reminder: `Tomorrow-ish: Editorial Review Reminder — 6 Hours`;
- 24-hour reminder: `Tomorrow-ish: Final Editorial Reminder — 24 Hours`.

## Required configuration

Plain-text variables:

- `EDITORIAL_NOTIFICATION_FROM_EMAIL=editorial@tomorrow-ish.news`
- `REVIEW_NOTIFICATION_EXTERNAL_URL=https://tomorrow-ish.news/api/internal/editorial-email-delivery`

Worker secrets:

- `RESEND_API_KEY`
- `RESEND_WEBHOOK_SIGNING_SECRET`
- `EDITORIAL_NOTIFICATION_TO_EMAIL`
- `REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN`

The destination email is treated as a secret binding so the address is not copied into source-controlled Wrangler configuration or release evidence. `EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED` must remain explicitly `false` for disabled deployment.

## Resend setup, not performed locally

1. Create or select the Resend account.
2. Add and verify `tomorrow-ish.news` as a sending domain.
3. Publish the exact SPF and DKIM records supplied by Resend. Do not guess record names or values. Wait for Resend to report the domain verified.
4. Create a least-purpose API key permitted to send from the verified domain.
5. Register `https://tomorrow-ish.news/api/internal/resend-delivery-webhook` for `email.delivered`, `email.delivery_delayed`, `email.failed`, `email.bounced`, and `email.suppressed`.
6. Save the resulting webhook signing secret as the Worker secret above.
7. Ensure Cloudflare routing permits this signed callback route without an interactive Access redirect. Do not weaken Access protection for `/editorial`.
8. Add the external adapter URL and secrets through a separately reviewed frozen-baseline transition while the capability gate remains false.
9. Use Resend's test-mode destination and mocked/non-production environment for acceptance before any real Gmail delivery is authorized.

## Investigation and recovery

The protected `/editorial/notifications` page lists `PENDING`, `FAILED`, and `AMBIGUOUS` source operations with their original idempotency key and provider reference. Provider callbacks are append-only in `resend_email_delivery_events`; destination reservations cannot be deleted.

For an ambiguous operation, search Resend by provider email ID and original idempotency key. Record governed operator reconciliation only when destination evidence is definitive. If outcome remains unknown, leave it ambiguous. Never resend it with a new key merely to clear the queue.
