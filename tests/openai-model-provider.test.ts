import { describe, expect, it, vi } from 'vitest';
import { ModelOutputError, ModelProviderError } from '../src/ai/model-provider';
import { ModelExecutionError, runWithLimits } from '../src/ai/model-runner';
import {
	ARTICLE_BODY_SCHEMA,
	CANDIDATE_SCHEMA,
	NORMALIZATION_SCHEMA,
	OpenAIModelProvider,
	OPENAI_MODEL,
	OPENAI_RESPONSES_URL,
} from '../src/ai/openai-model-provider';

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

function providerErrorResponse(
	status: number,
	error: { type?: unknown; code?: unknown; message?: unknown },
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	});
}

async function providerFailure(response: Response): Promise<ModelProviderError> {
	const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, async () => response);
	const error = await provider.normalizeEvent({ title: 'Event', neutralBrief: 'Brief', references: [reference] }, signal)
		.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(ModelProviderError);
	return error as ModelProviderError;
}

describe('OpenAI Responses provider', () => {
	it('uses only supported strict Structured Outputs keywords in both response schemas', () => {
		const normalizationSchema = JSON.stringify(NORMALIZATION_SCHEMA);
		const candidateSchema = JSON.stringify(CANDIDATE_SCHEMA);
		const bodySchema = JSON.stringify(ARTICLE_BODY_SCHEMA);
		expect(normalizationSchema).not.toContain('uniqueItems');
		expect(normalizationSchema).not.toMatch(/minLength|maxLength/);
		expect(candidateSchema).not.toMatch(/uniqueItems|minLength|maxLength/);
		expect(CANDIDATE_SCHEMA.properties.candidates).toMatchObject({ minItems: 5, maxItems: 5 });
		expect(CANDIDATE_SCHEMA.additionalProperties).toBe(false);
		expect(bodySchema).not.toMatch(/uniqueItems|minLength|maxLength/);
		expect(ARTICLE_BODY_SCHEMA.additionalProperties).toBe(false);
		expect(ARTICLE_BODY_SCHEMA.properties.factual_assertion_ids_used).toMatchObject({ minItems: 1, maxItems: 30 });
		expect(ARTICLE_BODY_SCHEMA.required).toContain('factual_assertion_ids_used');
		expect(ARTICLE_BODY_SCHEMA.properties).not.toHaveProperty('factual_assertions_used');
	});

	it('uses a receiver-safe native fetch wrapper by default', async () => {
		let receivedThis: unknown;
		const nativeFetch = vi.fn(function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
			receivedThis = this;
			return Promise.resolve(response(normalization));
		});
		vi.stubGlobal('fetch', nativeFetch);
		try {
			const provider = new OpenAIModelProvider('test-key');
			await provider.normalizeEvent({ title: 'Event', neutralBrief: 'Brief', references: [reference] }, signal);
			expect(nativeFetch).toHaveBeenCalledTimes(1);
			expect(receivedThis).not.toBe(provider);
		} finally {
			vi.unstubAllGlobals();
		}
	});

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

	it('accepts a valid distinct guardrail array', async () => {
		const output = { ...normalization, guardrailFlags: ['UNRESOLVED_ALLEGATION'] };
		const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, async () => response(output));
		await expect(provider.normalizeEvent({ title: 'Event', neutralBrief: 'Brief', references: [reference] }, signal))
			.resolves.toMatchObject({ output });
	});

	it('rejects duplicate guardrail flags in application validation', async () => {
		const output = { ...normalization, guardrailFlags: ['UNRESOLVED_ALLEGATION', 'UNRESOLVED_ALLEGATION'] };
		const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, async () => response(output));
		await expect(provider.normalizeEvent({ title: 'Event', neutralBrief: 'Brief', references: [reference] }, signal))
			.rejects.toThrow(/distinct/i);
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

	it('uses a separate governed contract for a complete article body', async () => {
		const output = {
			body_markdown: [
				'Authorities described the reported event in careful terms while the institution opened a routine review of its procedures.',
				'The review soon acquired a binder, a working group, and a diagram explaining which ordinary rule had become unexpectedly philosophical.',
				'Administrators then expanded the process into a broader policy exercise whose labels were substantially clearer than its consequences.',
				'By late afternoon, the matter was considered resolved enough to require one final meeting and a fresh version of the same diagram.',
			].join('\n\n'),
			factual_assertion_ids_used: ['fact-1'],
			satire_framing_summary: 'Retail policy absorbs the absurdity.',
			safety_notes: ['Preserve attribution.'],
		};
		const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
			const base = response(output);
			return new Response(base.body, { status: base.status, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_body_123' } });
		});
		const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, transport);
		const input = {
			source: {
				title: 'Reported parking-lot incident', neutralBrief: 'Authorities reported an arrest.',
				significanceScore: 2, satirePotentialScore: 4, satireSuitability: 'SENSITIVE',
				suitabilityReason: 'Unresolved allegation.', guardrailFlags: ['UNRESOLVED_ALLEGATION'],
				editorialNotes: '', references: [{ id: 'source-1', sourceTitle: 'Report',
					sourceUrl: 'https://news.example.test/report', publisherName: 'Newsroom',
					sourceTier: 'TIER_2', sourceType: 'LOCAL_NEWS', publishedAt: null }],
			},
			normalizedEvent: {
				id: 'version-1', eventStatement: 'Authorities reported an arrest.',
				proposedSuitability: 'SENSITIVE', suitabilityReason: 'Unresolved allegation.',
				guardrailFlags: ['UNRESOLVED_ALLEGATION'],
				assertions: [{ id: 'fact-1', kind: 'FACT', statement: 'Authorities reported an arrest.', sources: [{ sourceReferenceId: 'source-1', relationship: 'SUPPORTS' }] }],
				reviewReason: 'Use careful attribution.',
			},
			candidate: {
				headline: 'Retailer Reviews Parking-Lot Dress Code', deck: 'A reported incident prompts policy review.',
				rationale: 'Targets policy.', satiricalMechanism: 'bureaucratic extrapolation',
				category: 'Florida, Probably', editorialNotes: 'Target policy, not the accused person.',
			},
			governance: { sensitive: true, unresolvedAllegation: true, editorialCautionReason: 'Target policy, not the accused person.' },
		};
		const result = await provider.generateArticleBody(input, signal);
		const request = JSON.parse(String(transport.mock.calls[0][1]?.body));
		expect(request.text.format).toMatchObject({ type: 'json_schema', name: 'article_body', strict: true });
		expect(request.max_output_tokens).toBe(3_000);
		expect(request.instructions).toMatch(/four to seven|never imply guilt|Never fabricate quotations|persisted editorial caution/i);
		expect(request.instructions).toMatch(/factual_assertion_ids_used|immutable IDs|never select CONTEXT or UNCERTAINTY/i);
		expect(JSON.parse(request.input)).toEqual(input);
		expect(result.output).toEqual({
			bodyMarkdown: output.body_markdown,
			factualAssertionIdsUsed: output.factual_assertion_ids_used,
			satireFramingSummary: output.satire_framing_summary,
			safetyNotes: output.safety_notes,
		});
		expect(result.providerRequestId).toBe('req_body_123');
	});

	it('rejects an incomplete article body response', async () => {
		const output = {
			body_markdown: ['One.', 'Two.', 'Three.'].join('\n\n'), factual_assertion_ids_used: ['fact-1'],
			satire_framing_summary: 'Framing.', safety_notes: [],
		};
		const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, async () => response(output));
		await expect(provider.generateArticleBody({
			source: { title: 'Event', neutralBrief: 'Fact.', significanceScore: 1, satirePotentialScore: 1,
				satireSuitability: 'SUITABLE', suitabilityReason: 'Reviewed.', guardrailFlags: [], editorialNotes: '', references: [] },
			normalizedEvent: { id: 'v1', eventStatement: 'Event', proposedSuitability: 'SUITABLE',
				suitabilityReason: 'Reviewed.', guardrailFlags: [], assertions: [], reviewReason: 'Reviewed.' },
			candidate: { headline: 'Headline', deck: 'Deck', rationale: 'Reason', satiricalMechanism: 'Mechanism', category: 'Science', editorialNotes: '' },
			governance: { sensitive: false, unresolvedAllegation: false, editorialCautionReason: null },
		}, signal)).rejects.toBeInstanceOf(ModelOutputError);
	});

	it.each([
		['missing v2 provenance field', {}],
		['article-body-v1 provenance field only', { factual_assertions_used: ['Authorities reported an arrest.'] }],
		['both v2 and forbidden v1 provenance fields', {
			factual_assertion_ids_used: ['fact-1'], factual_assertions_used: ['Authorities reported an arrest.'],
		}],
	])('rejects %s', async (_label, provenance) => {
		const output = {
			body_markdown: [
				'Authorities described the reported event in careful terms while the institution opened a routine review of its procedures.',
				'The review soon acquired a binder, a working group, and a diagram explaining which ordinary rule had become unexpectedly philosophical.',
				'Administrators then expanded the process into a broader policy exercise whose labels were substantially clearer than its consequences.',
				'By late afternoon, the matter was considered resolved enough to require one final meeting and a fresh version of the same diagram.',
			].join('\n\n'),
			...provenance,
			satire_framing_summary: 'Retail policy absorbs the absurdity.',
			safety_notes: [],
		};
		const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, async () => response(output));
		await expect(provider.generateArticleBody({
			source: { title: 'Event', neutralBrief: 'Fact.', significanceScore: 1, satirePotentialScore: 1,
				satireSuitability: 'SUITABLE', suitabilityReason: 'Reviewed.', guardrailFlags: [], editorialNotes: '', references: [] },
			normalizedEvent: { id: 'v1', eventStatement: 'Event', proposedSuitability: 'SUITABLE',
				suitabilityReason: 'Reviewed.', guardrailFlags: [], assertions: [{ id: 'fact-1', kind: 'FACT', statement: 'Fact.', sources: [] }], reviewReason: 'Reviewed.' },
			candidate: { headline: 'Headline', deck: 'Deck', rationale: 'Reason', satiricalMechanism: 'Mechanism', category: 'Science', editorialNotes: '' },
			governance: { sensitive: false, unresolvedAllegation: false, editorialCautionReason: null },
		}, signal)).rejects.toBeInstanceOf(ModelOutputError);
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
		}, requestSignal), 100, { timeoutMs: 100, candidateTimeoutMs: 250, maxAttempts: 2, defaultCandidateCount: 5, maxInputCharacters: 1_000, maxOutputCharacters: 10_000, maxEstimatedCostMicrousd: 10_000 });
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

	it.each([
		[400, 'PROVIDER_REQUEST', 'invalid_request_error', 'invalid_value', 'A required field is invalid.'],
		[401, 'PROVIDER_AUTHENTICATION', 'authentication_error', 'invalid_api_key', 'Authentication failed.'],
		[403, 'PROVIDER_AUTHENTICATION', 'invalid_request_error', 'model_not_found', 'The model is unavailable to this project.'],
		[429, 'PROVIDER_RATE_LIMIT', 'insufficient_quota', 'insufficient_quota', 'Quota has been exceeded.'],
		[500, 'PROVIDER_SERVER', 'server_error', 'internal_error', 'The provider encountered an error.'],
	] as const)('captures safe structured diagnostics for HTTP %s', async (status, classification, type, code, message) => {
		const error = await providerFailure(providerErrorResponse(status, { type, code, message }));
		expect(error.failureClassification).toBe(classification);
		expect(error.responseDiagnostics).toEqual({
			httpStatus: status, errorType: type, errorCode: code, errorMessage: message,
			requestId: null, retryAfter: null,
		});
	});

	it('captures temporary rate-limit Retry-After and request ID without full headers', async () => {
		const error = await providerFailure(providerErrorResponse(429, {
			type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'Please retry later.',
		}, {
			'Retry-After': '12', 'x-request-id': 'req_safe_123',
			'Authorization': 'Bearer sk-never-persist', 'x-internal-secret': 'do-not-store',
		}));
		expect(error.responseDiagnostics).toEqual({
			httpStatus: 429, errorType: 'rate_limit_error', errorCode: 'rate_limit_exceeded',
			errorMessage: 'Please retry later.', requestId: 'req_safe_123', retryAfter: '12',
		});
		expect(JSON.stringify(error.responseDiagnostics)).not.toContain('never-persist');
		expect(JSON.stringify(error.responseDiagnostics)).not.toContain('do-not-store');
	});

	it.each([
		new Response('', { status: 400 }),
		new Response('not-json and must not be retained', { status: 400 }),
		new Response(JSON.stringify({ error: 'wrong shape' }), { status: 400 }),
	])('handles absent or malformed provider error bodies without retaining them', async (providerResponse) => {
		const error = await providerFailure(providerResponse);
		expect(error.responseDiagnostics).toMatchObject({
			httpStatus: 400, errorType: null, errorCode: null, errorMessage: null,
		});
		expect(JSON.stringify(error.responseDiagnostics)).not.toContain('not-json');
	});

	it('sanitizes and bounds the documented provider message field', async () => {
		const error = await providerFailure(providerErrorResponse(400, {
			type: 'invalid_request_error', code: 'invalid_value',
			message: `Bad\nBearer sk-secret-token ${'x'.repeat(600)}`,
		}));
		expect(error.responseDiagnostics?.errorMessage).toContain('Bearer [REDACTED]');
		expect(error.responseDiagnostics?.errorMessage).not.toContain('sk-secret-token');
		expect(error.responseDiagnostics?.errorMessage?.length).toBeLessThanOrEqual(500);
	});

	it('aborts timed-out requests and stops after the bounded retry count', async () => {
		const transport = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
		}));
		const provider = new OpenAIModelProvider('test-key', OPENAI_MODEL, transport);
		const caught: unknown = await runWithLimits((requestSignal) => provider.normalizeEvent({
			title: 'Event', neutralBrief: 'Brief', references: [reference],
		}, requestSignal), 100, { timeoutMs: 5, candidateTimeoutMs: 10, maxAttempts: 2, defaultCandidateCount: 5, maxInputCharacters: 1_000, maxOutputCharacters: 10_000, maxEstimatedCostMicrousd: 10_000 }).catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(ModelExecutionError);
		if (!(caught instanceof ModelExecutionError)) throw new Error('Expected a model execution error.');
		expect(caught.retryCount).toBe(1);
		expect(transport).toHaveBeenCalledTimes(2);
		expect((caught.cause as DOMException).name).toBe('AbortError');
	});
});
