# ADR: Two-gate editorial workflow

## Decision

New automated intakes use two human gates:

```text
INGESTED -> SELECTED -> GENERATING -> READY_FOR_REVIEW -> PUBLISHED
    |                                      |
    +-----------------> REJECTED <---------+
```

Gate 1 is a batch intake decision: Generate or Reject. A selection authorizes the existing normalization, premise/headline, body, image, provenance, and validation services to run without another editorial stop. Gate 2 presents the complete source, story, and image package and requires an explicit Publish or Reject action. Edit and Regenerate Image keep the item in `READY_FOR_REVIEW`.

## Context and authority boundary

The legacy path asks humans to review substantially the same material at intake, normalization, candidate, body, image, and story stages. Those pages and records remain available for historical and manual work, but new batch automation no longer pauses at the redundant intermediate gates.

The editor retains authority to select source material, change final copy, reject at either gate, and publish. Silence never implies approval. Generation cannot publish, notification delivery cannot mutate editorial state, and the public repository still exposes only `PUBLISHED` stories.

## Persistence and identity

`automation_runs.id` is the durable batch identity because it exists when the three intake records are created; a candidate-generation `model_runs.id` exists only after a single intake is selected and cannot group Gate 1. `editorial_batch_items` links that batch to the source intake, generated candidate, and story without rewriting any historical candidate or story state.

The batch workflow state is an orchestration projection. Existing tables remain authoritative for source provenance, model runs, candidate/body history, images, stories, and publication. New automatic stories are stored in the compatible story status `REVIEW` while the projection exposes `READY_FOR_REVIEW`; explicit final publication performs the governed story transition to `PUBLISHED`.

## Idempotency and failure handling

Normalization, candidate generation, and body generation use stable batch-and-intake idempotency keys. Candidate and story uniqueness constraints prevent duplicate records. Image history remains append-only, and pending/generated images are reused after a retry or Worker restart. A failed item records a bounded stage/classification and can be retried without discarding completed durable stages. No automatic retry publishes or changes human decisions.

## Final review and images

The batch final-review screen includes source context, final copy, category, image status, and governance context. Saving an edit updates the existing story and records a workflow event without returning it to an earlier gate. Regeneration preserves the story ID and text and creates another governed image record; the replacement must be reviewed in the final package. Publish validates required story fields and an image, records actor/time, and has no additional approval screen.

## Reminders

Triage and final review are independent reminder phases. Each has its own initial, approximately six-hour, and approximately 24-hour schedule. Triage counts only `INGESTED`; final review counts only `READY_FOR_REVIEW`. Publish/Reject resolve final items, while Edit and Regenerate Image do not. See `docs/editorial-review-reminders.md`.

## Backward compatibility

No historical record is rewritten. Legacy intake, candidate, story, audit, and image routes stay readable and retain their existing state transitions. The new projection applies only to intakes recorded into an editorial batch after migration `0014` is installed.

## Consequence

The normal session becomes: review three intakes, select worthwhile stories, leave generation alone, then review and dispose of the completed batch. The removed gates reduce navigation and duplicate judgment without expanding machine publication authority.
