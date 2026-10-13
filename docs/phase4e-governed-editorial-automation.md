# Phase 4E governed editorial automation

This is a tested local design checkpoint, not production activation authority. Migration `0023_governed_editorial_automation.sql` is additive and seeds no work, approvals, authorizations, or budget records.

## Routine image preparation

`EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED` defaults to false and is independent of `IMAGE_GENERATION_ENABLED`. When both gates are explicitly true, only an item in the currently admitted `routine-generation:v1` batch can reserve an image attempt. The story must be complete and in `REVIEW`, the item must still be leased in `GENERATING`, and the admission date, batch, intake, and story must match.

The durable `article_images` reservation stores the visual direction, fully assembled prompt, exact workflow identity, New York operating date, conservative cost estimate, and deterministic attempt key before asynchronous submission. A partial unique index allows one routine attempt per story. Pending, ambiguous, failed, and successful attempts all consume that one-attempt allowance and budget exposure. A delayed signed callback can resolve only the original request. Successful completion stops at `GENERATED`; it never approves the image or publishes the story.

The reviewed image ceilings are 50,000 microusd per attempt and 150,000 microusd per three-story batch and New York operating day. Admission is one atomic D1 insert. Missing, malformed, or different enabled-mode values fail closed.

## Explicit publication authority

After an editor approves the article text and approves the matching image with final alt text, the batch review page offers an explicit `AUTHORIZE` action. It appends one `SCHEDULED_PUBLICATION_V1` record containing the authenticated actor, timestamp, story, approved image, batch, intake, candidate, story update timestamp, image review timestamp, asset key, and exact alt text. A linked audit row is committed in the same D1 batch.

Authorization evidence cannot be updated or deleted. It becomes invalid whenever the story update timestamp, attached image asset, image review timestamp, or final alt text no longer matches. A new explicit authorization is then required. The scheduled publisher requires both `EDITORIAL_AUTOMATED_PUBLICATION_ENABLED=true` and a currently valid authorization at claim time and again in the atomic publication update. Routine admission and selection lineage exclude fixtures, manual records, and historical backlog.

## Text budgets and operating day

The shared `model_budget_reservations` ledger now enforces operation, intake, workflow-batch, and `America/New_York` operating-day ceilings in its atomic admission statement. The reviewed text values are 170,000 microusd per intake and 510,000 microusd per three-item batch/day. Calendar windows are converted to UTC bounds and therefore remain correct across 23-hour and 25-hour daylight-saving transition days. Pending and ambiguous attempts retain full estimated exposure; definitive non-billable rejection is the only automatic release path.

These are conservative application estimates, not provider billing guarantees. Activation remains blocked until provider pricing, request shapes, and estimate formulas are independently rechecked. The application cannot impose a provider-side hard dollar cap or know final invoiced charges synchronously; price drift could make actual billing exceed the estimate even though admitted estimates remain bounded.

## Disabled deployment and activation blockers

The reviewed production baseline keeps model generation, budget admission, workflow generation, routine image preparation, image generation, external notifications, and automated publication disabled. A code-only disabled deployment still requires an approved source commit, fresh production backup, migration `0023`, exact generated/live configuration validation, paused-Cron procedure, rollback version evidence, and post-deployment observation.

Controlled activation additionally requires a reviewed real external notification HTTPS endpoint and bearer secret, provider-price verification, human acceptance of the three-story morning workflow, and separate authorization for each gate transition. No gate should be enabled by editing variables outside the release operator and exact baseline-transition checks.
