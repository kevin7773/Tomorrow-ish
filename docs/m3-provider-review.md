# M3 OpenAI provider preparation

Reviewed September 10, 2026. The provider-neutral M3 architecture now includes a native-fetch OpenAI adapter. Production generation remains disabled, no secret has been created, no live request has been made, and migration `0003` has not been applied to production.

## Recommendation

The adapter uses OpenAI `gpt-5.6-terra` through `POST /v1/responses`, called with native `fetch`, `store: false`, an empty tools array, `tool_choice: none`, and a strict JSON Schema response format. Store the API key as the Wrangler secret `OPENAI_API_KEY` only after a separate production-enablement review.

Terra is the appropriate first adapter because it is positioned as the balance of intelligence and cost, supports Structured Outputs, and permits `reasoning.effort: none`. That combination fits concise factual normalization and controlled dry-headline generation better than paying flagship rates or selecting the lowest-cost model before voice quality has been evaluated. The adapter should still pass every response through the existing explicit TypeScript validators; provider schema enforcement is not a replacement for application validation.

Official references:

- [GPT-5.6 Terra model and pricing](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)

## Working cost model

At the reviewed list rates of $2.00 per million input tokens and $12.00 per million output tokens:

| Operation | Estimated input | Estimated output | Estimated cost |
| --- | ---: | ---: | ---: |
| Normalize one intake | 1,500 tokens | 700 tokens | $0.0114 |
| Generate five candidates | 1,200 tokens | 750 tokens | $0.0114 |
| One intake through both model operations | 2,700 tokens | 1,450 tokens | $0.0228 |

At five intakes per editorial day, the working estimate is approximately $0.114 per day or $3.42 per 30-day month. These are planning estimates, not a quote. Actual token usage—including any billed reasoning tokens—and current provider pricing must be captured from the response usage and reviewed after a representative evaluation set.

## Implemented adapter constraints

- The configured model is exactly `gpt-5.6-terra`; the returned model/revision is recorded with every successful run.
- Set `store: false`; do not use conversations, background mode, web search, file search, or any other tool.
- Send only the editor-written intake brief and source-reference metadata already allowed by M3. Never fetch source URLs.
- Reject refusals, incomplete responses, missing usage, schema drift, non-five candidate batches, or unknown provenance IDs.
- Token usage is converted to integer micro-USD at the reviewed $2/million input and $12/million output rates. Before each request, a deliberately conservative character-as-token upper bound reserves enough budget for the bounded response.
- Keep the existing timeout, bounded retry, idempotency, suitability, guardrail, audit, and publication-authority boundaries.

OpenAI states that API data is not used for training unless the customer opts in. Default abuse-monitoring logs may retain customer content for up to 30 days; eligible customers can request Modified Abuse Monitoring or Zero Data Retention. The Responses API defaults to stored application state when `store` is omitted, so the adapter must explicitly send `store: false` and the production owner should review project-level retention settings before enablement.

## Current production configuration

`wrangler.jsonc` contains non-secret configuration only:

```text
MODEL_PROVIDER=openai
MODEL_NAME=gpt-5.6-terra
MODEL_GENERATION_ENABLED=false
MODEL_DAILY_BUDGET_MICRO_USD=1000000
```

The daily hard budget is $1.00 in integer micro-USD. The request is rejected before transport if its conservative maximum, combined with recorded model-run cost since 00:00 UTC, would exceed that budget. Each run is also bounded to $0.10, 24,000 input characters, 24,000 output characters, two total attempts, and an eight-second timeout. Normalization has a 3,000-token response cap; five-candidate generation has a 2,500-token cap.

## Separate production enablement procedure

Do not perform these steps until migration `0003` and real generation are separately authorized.

1. Create the secret interactively; paste the key only at Wrangler's prompt:

   ```powershell
   npx wrangler secret put OPENAI_API_KEY
   ```

2. Change only `MODEL_GENERATION_ENABLED` from `false` to `true` in `wrangler.jsonc` and review the $1.00 daily budget.
3. Run `npm run types`, `npm test`, `npm run check`, `npm run build`, `npx wrangler deploy --dry-run`, and `git diff --check`.
4. Verify the dry run contains the existing bindings plus the four non-secret model variables and no unexpected service or storage binding.
5. Commit and deploy only through a separately authorized production change.

The Worker fails closed when generation is enabled but the provider, model, key, or budget is missing or invalid. The key is read only by the narrow runtime factory and passed to the provider; the provider receives no D1 repository or editorial/publication service.
