# Governed notification acceptance test

The acceptance-test path proves one Resend submission and signed delivery callback without enabling routine editorial reminders. It is not a second scheduler and never reads or writes `external_review_notification_deliveries`.

## Disabled production state

The reviewed disabled release requires:

- `EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED=false`
- `EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID=` (blank)
- `EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED=false`

Migration `0025_notification_acceptance_tests.sql` adds an isolated, append-only acceptance-test reservation and event ledger. Installing the migration and deploying the disabled configuration cannot send email.

## One-time authorization

A future acceptance window requires a separately reviewed complete Worker configuration with:

- `EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED=true`
- `EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID=<new unique authorization id>`
- `EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED=false`

The authorization ID must contain 16–200 lowercase letters, digits, colons, underscores, or hyphens. It is not a credential; Cloudflare Access, same-origin CSRF protection, the authorized editor allowlist, and the one-time database constraint supply the authority boundary. A fresh ID is required for every separately approved test.

An authenticated editor opens `/editorial/notifications`, reviews the displayed ID, types `SEND ONE TEST EMAIL`, and submits once. The action derives the immutable idempotency key `editorial-notification-acceptance-test:<authorization-id>`. It writes the `PENDING` reservation and `AUTHORIZED` event before constructing the Resend provider. The recipient is read only from `EDITORIAL_NOTIFICATION_TO_EMAIL`; no recipient is accepted from the form.

Repeated or concurrent POSTs return the existing state and never call Resend again. `PENDING`, `AMBIGUOUS`, `FAILED`, and `DELIVERED` are all non-retryable under the same authorization. Network loss, timeout, uncertain HTTP responses, and accepted-response persistence failures remain `AMBIGUOUS` until signed provider evidence resolves them.

Immediately after the one submission, restore the two acceptance-test variables to their disabled values through a reviewed configuration transition. The signed `/api/internal/resend-delivery-webhook` route remains able to resolve the existing attempt while both notification gates are false.

## Required provider evidence

Before authorizing the send, retain separately authenticated Resend evidence showing:

1. `tomorrow-ish.news` is verified for sending.
2. The configured webhook is exactly `https://tomorrow-ish.news/api/internal/resend-delivery-webhook`.
3. Subscriptions include `email.delivered`, `email.delivery_delayed`, `email.failed`, `email.bounced`, and `email.suppressed`.
4. The production send-only API key belongs to the Tomorrow-ish account/project. Do not broaden that key; use the dashboard or a separately approved read-only credential.

## Acceptance evidence

Success requires one acceptance-test row, one provider submission, a provider email ID, one verified `email.delivered` event, final `DELIVERED` state, and recipient confirmation. Duplicate webhook delivery must produce a duplicate acknowledgement without a second state change. Stop without retrying if any outcome is ambiguous.

