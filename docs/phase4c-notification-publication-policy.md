# Phase 4C notification and publication policy

Phase 4C adds two opt-in automation services. Both are disabled when their configuration variable is absent, blank, or `false`. Any other value fails closed. Neither service grants editorial approval, approves an image, creates content, invokes a model, or relaxes publication prerequisites.

## External editorial reminders

`EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED=true` enables external delivery after the existing D1-backed internal inbox accepts the same initial, six-hour, or 24-hour reminder. `REVIEW_NOTIFICATION_EXTERNAL_URL` must identify the reviewed HTTPS destination and `REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN` must be supplied as a Worker secret. The existing `REVIEW_NOTIFICATION_WEBHOOK_URL` points to the Worker's internal compatibility receiver and must not be treated as an external destination.

D1 remains authoritative. A unique operation record is inserted as `PENDING` before transport construction. Only HTTP 200 with an explicit matching delivered acknowledgement becomes `DELIVERED`. Queued responses, network loss, timeouts, HTTP 5xx responses, acknowledgement mismatch, and completion-persistence uncertainty become `AMBIGUOUS`; they are not automatically submitted again. Definitive configuration, validation, or HTTP 4xx rejections become `FAILED`. Authenticated operators may append governed reconciliation evidence after checking the destination by idempotency key; reconciliation itself never resends.

The internal inbox remains active when external delivery is disabled. An incomplete three-article final-review batch cannot emit its initial ready-for-review notification.

## Governed scheduled publication

`EDITORIAL_AUTOMATED_PUBLICATION_ENABLED=true` is the existing global automation authorization policy that adapts the manual `PUBLISH` confirmation. It may be enabled only after separate production review. It is not implied by article or image approval. Phase 4D recommends adding a separate immutable per-story automation opt-in before production activation; the global switch alone is too broad for the initial rollout.

The scheduled publisher considers only records created under `routine-generation:v1`. Eligibility requires all of the following at the instant of the database transition:

- workflow state `READY_FOR_REVIEW`;
- story state `APPROVED`, nonblank headline and body, and no publication timestamp;
- one active governed candidate selection matching the workflow candidate and story origin;
- the selected candidate's accepted normalization matching the workflow intake;
- an explicitly `APPROVED` image belonging to the story whose asset key exactly matches `stories.og_image_key`;
- no active foreign workflow lease; and
- a recorded initial final-review reminder proving the three-article batch reached its complete review-ready boundary; and
- a current durable publication ownership claim.

The final story update invokes a database trigger that changes the workflow state, appends the editorial audit record and workflow event, and finalizes the publication attempt in the same SQLite statement. A repeated or concurrent attempt cannot publish again. Historical fixtures, manually created stories, and workflow rows without the routine-selection marker are excluded.

## Deployment posture

Migration `0021_notification_delivery_and_automated_publication.sql` is additive. A disabled-mode deployment must leave both new variables absent or explicitly `false`. Enabling either variable requires a separate frozen-baseline configuration transition. Before enabling external delivery, replace or review the existing webhook URL as an actual external endpoint and establish operator handling for `FAILED` and `AMBIGUOUS` delivery records.
