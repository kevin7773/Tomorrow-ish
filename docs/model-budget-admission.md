# Atomic model-budget admission

Every paid normalization, candidate-generation, and article-body attempt must obtain a row in `model_budget_reservations` before a provider object is constructed. The attempt key is the immutable budget identity and is shared with the durable provider or body reservation. Manual editorial actions and scheduled workflow processing use the same D1 table and conditional insert.

## Cost meanings

- `estimated_cost_microusd` is the conservative pre-submission exposure used for admission.
- `usage_recorded_cost_microusd` is calculated from usage returned with a definitive provider response. It is not a provider invoice.
- `verified_billed_cost_microusd` is reserved for independently reconciled provider billing and is never inferred from an estimate.

`RESERVED` and `AMBIGUOUS` rows consume their full estimate. `FINALIZED` rows consume verified billing when available, otherwise usage-derived cost, otherwise the estimate. `RELEASED` consumes no budget and is allowed only when the outcome definitively establishes that no billable request was accepted. Timeouts, network loss, lost responses, and lease loss retain exposure.

## Configuration

Budget admission is fail-closed and disabled by default. Routine model generation requires both `MODEL_GENERATION_ENABLED=true` and `MODEL_BUDGET_ADMISSION_ENABLED=true`, plus positive integer values for:

- `MODEL_NORMALIZE_MAX_COST_MICRO_USD`
- `MODEL_CANDIDATES_MAX_COST_MICRO_USD`
- `MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD`
- `MODEL_ITEM_BUDGET_MICRO_USD`
- `MODEL_DAILY_BUDGET_MICRO_USD`

The daily boundary is UTC. A per-item ceiling accumulates all three model operations for one source intake. Unresolved historical attempts without a budget row make admission fail closed for that intake; they require investigation rather than inferred cost or automatic replay.

## Disabled-mode rollout

1. Keep model, workflow, image, and model-budget admission gates false.
2. Back up D1 and apply only migration `0020_atomic_model_budget_reservations.sql`.
3. Verify the new table, indexes, immutable triggers, and zero new rows.
4. Deploy through the reviewed release operator with all gates false.
5. Observe disabled Cron windows and confirm no provider, reservation, workflow, or editorial changes.
6. Configure reviewed positive ceilings while leaving admission and generation disabled.
7. Enable spending only under a separate authorization that turns on budget admission before any model generation gate.

Rollback must use a pre-verified all-generation-disabled Worker. The additive table may remain installed; do not improvise a destructive down migration.

The current Phase 4A release contract compares live variables to a frozen baseline exactly. The first disabled-mode code/migration rollout therefore keeps the existing production variables unchanged; absent budget variables resolve to disabled. Adding the new variables and updating the frozen baseline is a separate reviewed configuration transition and must not be folded into the code deployment by bypassing that comparison.
