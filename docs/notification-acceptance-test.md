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

## Reviewed temporary release transition

The canonical production baseline remains disabled and blank. It must not be edited for an acceptance window. The only reviewed exception is the hash-pinned pair of contracts:

- `release/notification-acceptance-test-enable-transition.json`
- `release/notification-acceptance-test-disable-transition.json`

Both contracts change exactly the test gate and authorization ID. The ID is accepted only when its SHA-256 fingerprint matches the reviewed DPAPI-protected value. All seven routine capability gates remain exactly `false`. Without the explicit transition contract, generated-configuration, live-snapshot, and uploaded-version validation continue to reject an enabled test gate or nonblank authorization.

After a clean build and `npm run release:prepare`, generate the short-lived operator artifacts from the existing protected ID:

```powershell
npm run release:acceptance:prepare -- `
  -ProtectedAuthorizationPath '.release/private/phase4i8-phase4i8-20261014-071729/acceptance-authorization-id.dpapi' `
  -PrivateDirectory '.release/private/notification-acceptance'
```

The wrapper decrypts only in process memory, sends the ID to Node over stdin, pins it to the reviewed fingerprint, and restricts the generated files to the current Windows identity. The ignored `dist/server/wrangler.acceptance*.json` files and private target baseline necessarily contain the temporary plain-text Worker variable. Never print, copy, commit, or retain them after reversal.

Validate the prepared target locally:

```powershell
node scripts/release/validate-release.mjs `
  --config dist/server/wrangler.acceptance.json `
  --baseline .release/private/notification-acceptance/production-baseline.acceptance-enabled.json `
  --package-dir .release/wrangler-dry-run `
  --transition-from-baseline release/production-baseline.json `
  --transition-contract release/notification-acceptance-test-enable-transition.json
```

For a separately authorized production window, pause Cron with the canonical disabled baseline first. Upload, inspect, and activate the acceptance version only with the private target baseline/configuration plus the enable contract. A fresh live snapshot must be validated in `previous` mode before activation and in `target` mode afterward. Restore Cron only after target-mode validation succeeds.

Immediately after the single submission, pause Cron under the enabled target baseline, then activate the previously inspected disabled Worker using the canonical baseline plus the disable contract and the private enabled baseline as `--transition-from-baseline`. Validate the disabled live state, restore the original schedules, and delete only these short-lived files:

```powershell
Remove-Item -LiteralPath 'dist/server/wrangler.acceptance.json' -Force
Remove-Item -LiteralPath 'dist/server/wrangler.acceptance.pause.json' -Force
Remove-Item -LiteralPath 'dist/server/wrangler.acceptance.restore.json' -Force
Remove-Item -LiteralPath '.release/private/notification-acceptance' -Recurse -Force
```

Retain the DPAPI-protected source and redacted operational evidence. If upload, activation, submission, or state verification is uncertain, do not retry; preserve evidence and proceed only with the reviewed disable transition when its prerequisites are provable.

## Required provider evidence

Before authorizing the send, retain separately authenticated Resend evidence showing:

1. `tomorrow-ish.news` is verified for sending.
2. The configured webhook is exactly `https://tomorrow-ish.news/api/internal/resend-delivery-webhook`.
3. Subscriptions include `email.delivered`, `email.delivery_delayed`, `email.failed`, `email.bounced`, and `email.suppressed`.
4. The production send-only API key belongs to the Tomorrow-ish account/project. Do not broaden that key; use the dashboard or a separately approved read-only credential.

## Acceptance evidence

Success requires one acceptance-test row, one provider submission, a provider email ID, one verified `email.delivered` event, final `DELIVERED` state, and recipient confirmation. Duplicate webhook delivery must produce a duplicate acknowledgement without a second state change. Stop without retrying if any outcome is ambiguous.
