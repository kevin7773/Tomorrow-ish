# M3 real-provider review

Reviewed September 10, 2026. This is a recommendation only; M3 does not include a real adapter, secret, binding, or production model configuration.

## Recommendation

Use OpenAI `gpt-5.6-terra` through `POST /v1/responses`, called with native `fetch`, `store: false`, no tools, and a strict JSON Schema response format. Store the API key as the Wrangler secret `OPENAI_API_KEY` only after a separate production-enablement review.

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

## Adapter constraints

- Pin a provider revision/snapshot when OpenAI publishes a stable snapshot; record the returned model/revision with every run.
- Set `store: false`; do not use conversations, background mode, web search, file search, or any other tool.
- Send only the editor-written intake brief and source-reference metadata already allowed by M3. Never fetch source URLs.
- Reject refusals, incomplete responses, missing usage, schema drift, non-five candidate batches, or unknown provenance IDs.
- Convert token usage to integer micro-USD using reviewed rates in configuration, and version those rates independently of the prompt.
- Keep the existing timeout, bounded retry, idempotency, suitability, guardrail, audit, and publication-authority boundaries.

OpenAI states that API data is not used for training unless the customer opts in. Default abuse-monitoring logs may retain customer content for up to 30 days; eligible customers can request Modified Abuse Monitoring or Zero Data Retention. The Responses API defaults to stored application state when `store` is omitted, so the adapter must explicitly send `store: false` and the production owner should review project-level retention settings before enablement.
