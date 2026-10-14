# Production automation activation contract

Production remains fully disabled by default. The canonical `wrangler.jsonc`, generated
`dist/server/wrangler.json`, and `release/production-baseline.json` continue to require all
seven routine capability gates to be `false`. An enabled artifact is valid only when it is
paired with an exact, generated transition contract and the release operator validates the
observed source state, target configuration, uploaded version, and rollback version.

## Reviewed capability states

| State | Notifications | Budget/model/workflow/images | Publication | UTC boundary |
| --- | --- | --- | --- | --- |
| `disabled` | off | off | off | absent |
| `notifications` | on | off | off | absent |
| `generation-acceptance` | on | on | off | required |
| `publication` | on | off | on | absent |
| `routine` | on | on | on | required |

Generation gates are indivisible: budget admission, model generation, workflow generation,
routine image preparation, and image generation must all be enabled together. The configured
operation, intake, batch, New York operating-day, and image ceilings remain exact. Missing or
malformed `EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE` values fail closed.

Allowed staged edges are encoded in `release-safety.mjs`. They cover notification activation,
bounded generation, publication after generation has stopped, routine operation after acceptance,
and exact reversals to `notifications` or fully `disabled`. Direct `disabled -> routine` activation
is intentionally rejected.

## Preparing an exact transition

First build and package the approved source commit using the ordinary release preparation path.
Then generate private transition artifacts. They are ignored by Git and contain no secrets:

```powershell
npm run release:automation:prepare -- --from disabled --to notifications
```

For `generation-acceptance` or `routine`, supply the separately reviewed boundary:

```powershell
npm run release:automation:prepare -- `
  --from notifications `
  --to generation-acceptance `
  --not-before 2026-10-15T12:00:00.000Z
```

The command writes:

- `.release/private/automation-transition/production-baseline.previous.json`
- `.release/private/automation-transition/production-baseline.target.json`
- `.release/private/automation-transition/transition-contract.json`
- `dist/server/wrangler.automation.json`
- `dist/server/wrangler.automation.pause.json`
- `dist/server/wrangler.automation.restore.json`

Every changed value, including the UTC boundary, is exact in the generated contract. Review the
redacted preparation summary and the three IDs in the governed batch manifest before authorizing
an upload. The manifest remains D1-governed selection evidence: exactly three `SELECTED` items,
each with `INTAKE_SELECTED` detail `routine-generation:v1`, in one batch created at or after the
boundary. It is never inferred from historical `SELECTED` or `FAILED` rows.

Validate the observed source state with `--live-state previous`, then upload and inspect the target
using the generated target baseline and configuration. After activation, validate with
`--live-state target`. All operator commands must include:

```text
--config dist/server/wrangler.automation.json
--baseline .release/private/automation-transition/production-baseline.target.json
--transition-from-baseline .release/private/automation-transition/production-baseline.previous.json
--transition-contract .release/private/automation-transition/transition-contract.json
```

Use the same arguments with the `.pause.json` and `.restore.json` files through the established
release operator. Never use direct `wrangler deploy` or a root-config upload.

## Stage sequence and reversals

1. `disabled -> notifications`: enables final-review email only. Reverse with
   `notifications -> disabled`.
2. `notifications -> generation-acceptance`: requires an exact UTC boundary and reviewed
   three-intake manifest. After the bounded provider window, use
   `generation-acceptance -> notifications`; emergency rollback may use
   `generation-acceptance -> disabled`.
3. `generation-acceptance -> publication`: disables every generation gate, removes the boundary,
   and enables scheduled publication while notifications remain active. It does not create human
   approval or per-story authorization. Reverse with `publication -> notifications` or
   `publication -> disabled`.
4. `publication -> routine`: after successful acceptance evidence, re-enables the indivisible
   generation group with a newly reviewed UTC boundary. Reverse with `routine -> publication`,
   `routine -> notifications`, or `routine -> disabled`.

The existing verified fully disabled Worker remains the emergency rollback target. Rollback
inspection continues to require all seven gates false, a blank image smoke key, a disabled
acceptance-test gate, and a blank acceptance authorization ID.

## Notification scope

Internal TRIAGE reminders continue through the existing scheduler and D1 reminder ledger.
`FinalReviewExternalNotifier` prevents TRIAGE notifications from reaching Resend. External email is
available only for `FINAL_REVIEW`; the existing initial, six-hour, and 24-hour idempotency keys,
durable reservations, signed callback reconciliation, and resolution checks are unchanged.
