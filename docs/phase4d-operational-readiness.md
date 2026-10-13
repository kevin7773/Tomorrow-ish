# Phase 4D operational readiness

This document describes the local, disabled-by-default design checkpoint. It is not production activation authority.

## Routine batch admission

Routine generation is limited to one batch of exactly three selected intakes per `America/New_York` calendar day. Migration `0022_operational_admission_and_notification_reconciliation.sql` adds an immutable admission row keyed by operating date. Concurrent processors reuse the same admitted batch. Failed or incomplete work retains that day's admission and cannot cause a replacement batch to start.

Only batches created at or after the explicit UTC `EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE` boundary are eligible. Every item must remain `SELECTED` and have an `INTAKE_SELECTED` event marked `routine-generation:v1`. Missing or malformed activation configuration, a non-three-item batch, historical work, or no eligible work is a fail-closed no-op. The processor claims work only from the admitted batch.

## External notification contract

No external destination is currently established: the existing production-compatible webhook URL is the Worker's own internal receiver. External activation is therefore blocked until an operator supplies and reviews a real HTTPS destination plus bearer secret.

The outbound contract and reconciliation procedure are documented in `docs/editorial-review-reminders.md`. Confirmed delivery requires a matching HTTP 200 acknowledgement; queued and uncertain outcomes remain `AMBIGUOUS`, and no automatic resend occurs. D1 holds the attempt and reconciliation ledger. The external service should retain its own searchable idempotency-key ledger for investigation.

## Five-minute image review experience

The current image subsystem safely supports durable, one-attempt generation, signed delayed callbacks, immutable provenance, explicit rejection/regeneration, and explicit approval. It does not yet safely prepare images automatically for ordinary routine stories. Its automated path is still tied to the historical exact smoke target and explicit attempt-key controls.

The smallest safe follow-up is:

1. Add `EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED=false` and require the admitted routine batch.
2. Persist a reviewed default visual direction and assembled prompt for each story before submission.
3. Admit image cost separately, reserve exactly one attempt per story, and never replay uncertain attempts.
4. Permit delayed signed callbacks to resolve only their original attempt.
5. Leave each successful image `GENERATED`; only a human may approve or reject it and supply final alt text.
6. Keep publication blocked for missing, failed, rejected, ambiguous, or unapproved images.

Until that work is implemented, editors may receive three completed text articles without corresponding proposed images. This is the primary blocker to the preferred five-minute review session, but not to a disabled production deployment.

## Publication authority

The required transition is: a human approves text; a human approves the matching image and its alt text; then scheduled publication may atomically change the `APPROVED` story and `READY_FOR_REVIEW` workflow to `PUBLISHED`. Automation never grants either approval.

The current publisher already checks the routine selection lineage, exact story/candidate/intake relationship, accepted normalization, approved matching image and `og_image_key`, three-item final-review readiness, lease ownership, and immutable publication attempt. Phase 4D recommends an additional append-only per-story opt-in, recorded by an authenticated editor after both approvals, before enabling the global scheduler. This makes publication intent explicit and prevents a global switch from publishing every newly eligible story. Adding this opt-in is a production-activation blocker.

## Initial budget proposal

All figures are conservative application admission limits, not provider billing:

| Scope | Proposed limit |
| --- | ---: |
| Normalization operation | 50,000 microusd |
| Candidate generation operation | 50,000 microusd |
| Article body operation | 60,000 microusd |
| Text per intake | 170,000 microusd |
| Text per three-item batch | 510,000 microusd |
| Text per New York operating day | 510,000 microusd |
| Image operation | 50,000 microusd |
| Image per three-item batch | 150,000 microusd |
| Image per New York operating day | 150,000 microusd |
| Combined maximum daily exposure | 660,000 microusd ($0.66) |

The existing model ledger supports operation, intake, and UTC-day limits. Before routine activation it needs an atomic batch ceiling and New York operating-day alignment, or a separately reviewed proof that the one immutable daily batch admission plus the configured model daily ceiling provides equivalent containment. Image exposure must remain a separate ledger and gate. Pending and ambiguous attempts continue consuming exposure.

## Release posture

A disabled production deployment is acceptable after tests and migration replay pass because all generation, external notification, routine image preparation, and publication switches remain false or absent. Activation is **not** ready until an external destination is reviewed, routine image preparation exists (if the five-minute experience is required), per-story publication opt-in is implemented, and batch/day budget containment is reviewed end to end.
