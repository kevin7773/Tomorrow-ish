import { describe, expect, it, vi } from 'vitest';
import { ModelOutputError, ModelProviderError } from '../src/ai/model-provider';
import { ModelExecutionError, runWithLimits } from '../src/ai/model-runner';
import { OpenAIModelProvider, OPENAI_MODEL, OPENAI_RESPONSES_URL } from '../src/ai/openai-model-provider';

const signal = new AbortController().signal;
const reference = {
	id: 'source-1', sourceIntakeId: 'intake-1', sourceTitle: 'Public record',
	sourceUrl: 'https://example.com/not-sent', publisherName: 'Example', sourceTier: 'TIER_1' as const,
	sourceType: 'PRIMARY' as const, publishedAt: null, createdAt: '2026-09-10T00:00:00Z',
	updatedAt: '2026-09-10T00:00:00Z',
};

const normalization = {
	eventStatement: 'Agency opened a drawer.',
	assertions: [
		{ kind: 'FACT', statement: 'The agency opened a drawer.', sources: [{ sourceReferenceId: 'source-1', relationship: 'SUPPORTS' }] },
		{ kind: 'UNCERTAINTY', statement: 'The contents were not described.', sources: [{ sourceReferenceId: 'source-1', relationship: 'SUPPORTS' }] },
		{ kind: 'CONTEXT', statement: 'Drawers are used for storage.', sources: [{ sourceReferenceId: 'source-1', relationship: 'CONTEXT' }] },
	],
	proposedSignificanceScore: 1, proposedSatirePotentialScore: 3,
	proposedSuitability: 'SUITABLE', suitabilityReason: 'Low-harm institutional subject.', guardrailFlags: [],
};

const candidates = Array.from({ length: 5 }, (_, index) => ({
	headline: `Agency Opens Drawer ${index + 1}`,
	deck: `The inventory process enters phase ${index + 1}.`,
	rationale: 'Extends the accepted event through institutional specifics.',
	satiricalMechanism: 'bureaucratic extrapolation',
}));

function response(output: unknown, status = 200, usage = { input_tokens: 100, output_tokens: 50 }): Response {
	return new Response(JSON.stringify({
		status: 'completed', model: `${OPENAI_MODEL}-2026-09-01`,
		output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }], usage,
	}), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('OpenAI Responses provider', () => {
	it('sends the reviewed normalization contract without source URLs, tools, or storage', async () => {
		const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(normalization));
		const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, transport);
		const result = await provider.normalizeEvent({
			title: 'Agency Opens Drawer', neutralBrief: 'A drawer was opened.', references: [reference],
		}, signal);
		expect(transport).toHaveBeenCalledTimes(1);
		const [url, init] = transport.mock.calls[0];
		expect(url).toBe(OPENAI_RESPONSES_URL);
		const request = JSON.parse(String(init?.body));
		expect(request).toMatchObject({
			model: 'gpt-5.6-terra', store: false, tools: [], tool_choice: 'none', parallel_tool_calls: false,
			text: { format: { type: 'json_schema', name: 'normalized_event', strict: true } },
		});
		expect(request).not.toHaveProperty('include');
		expect(request.input).not.toContain(reference.sourceUrl);
		expect(request.input).not.toContain(reference.createdAt);
		expect(result.output).toEqual(normalization);
		expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 50, estimatedCostMicrousd: 800 });
	});

	it('requests and validates exactly five candidate alternatives', async () => {
		const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ candidates }));
		const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, transport);
		const result = await provider.generateCandidates({
			eventStatement: 'Agency opened a drawer.', facts: ['A drawer opened.'], uncertainties: [], context: [],
			suitabilityReason: 'Reviewed.', guardrailFlags: [], count: 5,
		}, signal);
		const request = JSON.parse(String(transport.mock.calls[0][1]?.body));
		expect(request.text.format).toMatchObject({ type: 'json_schema', name: 'satire_candidates', strict: true });
		expect(request.text.format.schema.properties.candidates).toMatchObject({ minItems: 5, maxItems: 5 });
		expect(result.output).toEqual(candidates);
	});

	it('rejects malformed structured output before it can be persisted', async () => {
		const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, async () => response({ candidates: candidates.slice(0, 4) }));
		await expect(provider.generateCandidates({
			eventStatement: 'Event', facts: [], uncertainties: [], context: [], suitabilityReason: 'Reviewed.', guardrailFlags: [], count: 5,
		}, signal)).rejects.toBeInstanceOf(ModelOutputError);
	});

	it('retries bounded transient failures and captures successful usage', async () => {
		const transport = vi.fn()
			.mockResolvedValueOnce(new Response('sensitive provider text', { status: 500 }))
			.mockResolvedValueOnce(response(normalization));
		const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, transport);
		const executed = await runWithLimits((requestSignal) => provider.normalizeEvent({
			title: 'Event', neutralBrief: 'Brief', references: [reference],
		}, requestSignal), 100, { timeoutMs: 100, maxAttempts: 2, defaultCandidateCount: 5, maxInputCharacters: 1_000, maxOutputCharacters: 10_000, maxEstimatedCostMicrousd: 10_000 });
		expect(transport).toHaveBeenCalledTimes(2);
		expect(executed.retryCount).toBe(1);
		expect(executed.result.usage.estimatedCostMicrousd).toBe(800);
	});

	it('does not retry permanent failures or expose provider response text', async () => {
		const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, async () => new Response('secret diagnostic', { status: 401 }));
		const caught: unknown = await runWithLimits((requestSignal) => provider.normalizeEvent({
			title: 'Event', neutralBrief: 'Brief', references: [reference],
		}, requestSignal), 100).catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(ModelExecutionError);
		if (!(caught instanceof ModelExecutionError)) throw new Error('Expected a model execution error.');
		expect(caught.retryCount).toBe(0);
		expect(caught.message).not.toContain('secret diagnostic');
		expect(caught.cause).toBeInstanceOf(ModelProviderError);
		expect((caught.cause as ModelProviderError).failureClassification).toBe('PROVIDER_AUTHENTICATION');
	});

	it('aborts timed-out requests and stops after the bounded retry count', async () => {
		const transport = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
		}));
		const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, transport);
		const caught: unknown = await runWithLimits((requestSignal) => provider.normalizeEvent({
			title: 'Event', neutralBrief: 'Brief', references: [reference],
		}, requestSignal), 100, { timeoutMs: 5, maxAttempts: 2, defaultCandidateCount: 5, maxInputCharacters: 1_000, maxOutputCharacters: 10_000, maxEstimatedCostMicrousd: 10_000 }).catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(ModelExecutionError);
		if (!(caught instanceof ModelExecutionError)) throw new Error('Expected a model execution error.');
		expect(caught.retryCount).toBe(1);
		expect(transport).toHaveBeenCalledTimes(2);
		expect((caught.cause as DOMException).name).toBe('AbortError');
	});
});
