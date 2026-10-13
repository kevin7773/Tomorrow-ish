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

The reviewed initial production values are strings containing canonical positive integer microusd amounts:

| Variable | Reviewed value | Scope |
| --- | ---: | --- |
| `MODEL_BUDGET_ADMISSION_ENABLED` | `false` | Master admission gate; it remains off during the configuration-only transition. |
| `MODEL_NORMALIZE_MAX_COST_MICRO_USD` | `50000` | One normalization attempt. |
| `MODEL_CANDIDATES_MAX_COST_MICRO_USD` | `50000` | One candidate-generation attempt. The name is operation-scoped; routine workflow configuration currently requests one candidate. |
| `MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD` | `60000` | One article-body attempt. |
| `MODEL_ITEM_BUDGET_MICRO_USD` | `150000` | All model operations sharing one `source_intake_id`, including attempts from different batches. |
| `MODEL_DAILY_BUDGET_MICRO_USD` | `150000` | All model operations admitted during one UTC day. |

The current `gpt-5.6-terra` estimator reserves 2 microusd per conservative input token, 12 microusd per maximum output token, and a 6,000-character prompt overhead. These ceilings admit at most 1,000 persisted input characters for normalization, 4,000 for candidate generation, and 6,000 for article-body generation. The next character exceeds the corresponding ceiling. The estimator deliberately treats every input character as a token; a request that exceeds a ceiling stops before provider construction.

Daily and per-item accounting includes full estimates for `RESERVED` and `AMBIGUOUS` rows. `FINALIZED` rows count verified billing when available, otherwise usage-derived recorded cost, otherwise the estimate. `RELEASED` rows count zero only after definitive evidence establishes that no billable request was accepted. This behavior is atomic in D1 and shared by manual and scheduled routes.

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

## Reviewed configuration transition

`release/production-baseline.pre-model-budget.json` freezes the prior fully disabled configuration. `release/production-baseline.json` is the proposed configuration, and `release/model-budget-baseline-transition.json` permits exactly the five additions and one daily-ceiling replacement above. Transition validation compares every non-variable baseline field exactly and rejects any unlisted variable difference.

Before activation, validate the freshly captured live state as `previous`; after activation, validate it as `target`. Both validations still require the generated artifact to match the proposed target baseline exactly:

```powershell
npm run release:validate -- --transition-from-baseline release/production-baseline.pre-model-budget.json --transition-contract release/model-budget-baseline-transition.json --live-state previous --live-snapshot .release/live-before.json
npm run release:validate -- --transition-from-baseline release/production-baseline.pre-model-budget.json --transition-contract release/model-budget-baseline-transition.json --live-state target --live-snapshot .release/live-after.json
```

Rollback activates the pre-verified Worker version `9227db60-0cf8-436c-a626-61e25e80844a` with `--rollback-to-previous`, then validates a fresh live snapshot in `previous` mode. The additive migration remains installed. Do not edit variables piecemeal or infer a mixed state as successful.
