# Routine post-selection generation policy

Status: local implementation checkpoint. Production generation remains disabled.

## Eligibility

Routine processing is opt-in per workflow item. An item becomes eligible only when it is selected after this policy is deployed and its immutable `INTAKE_SELECTED` workflow event contains `routine-generation:v1`.

Historical `SELECTED` and `FAILED` rows do not have that marker and are never claimed by the routine processor. A future explicit retry of an eligible item retains the original marker, but no failed item retries automatically.

## Automatic normalization acceptance

The processor creates at most one normalization attempt for each workflow retry attempt. Automatic acceptance is permitted only when all of the following are true:

- the version is a model-origin `PROPOSED` version tied to a persisted model run;
- the proposed suitability is `SUITABLE`;
- there are no guardrail flags;
- the version contains at least one factual assertion;
- the generation service has already verified authoritative source support for every factual assertion.

Sensitive, unsuitable, editor-authored, guardrail-flagged, fact-free, conflicting, or pre-existing ungoverned normalization history stops the workflow for human review. Acceptance is recorded under `automation@tomorrow-ish.news` with the stable policy reason.

## Candidate generation and selection

Routine candidate generation requests exactly one candidate. The processor verifies that exactly one DRAFT candidate was persisted for the governed run and selects that sole candidate through the existing immutable candidate-selection mechanism. This is an identity choice, not a ranking among alternatives.

An existing valid governed selection is respected. Conflicting selection or provenance stops processing. Candidate and body provider attempts use stable operation/attempt keys, atomic budget admission, durable reservations, workflow lease fencing, and zero automatic retries.

## Review readiness

Routine text packages may enter `READY_FOR_REVIEW` without an image. This grants no approval or publication authority; the existing publication predicate still requires an APPROVED story, an explicitly APPROVED image, and an exact matching `og_image_key`.

A batch receives a final-review reminder only when it contains exactly three workflow items and all three are `READY_FOR_REVIEW`. Partial, failed, rejected, or mixed batches fail closed without a final-review notification.

Every story remains in `REVIEW` until a human editor explicitly approves or rejects it. Publication remains a separate governed action.
