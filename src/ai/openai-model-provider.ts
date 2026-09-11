import type { CandidateProposal, ModelOperation, ModelResult, NormalizationProposal } from '../domain/generation';
import { parseCandidateBatch, parseNormalizationProposal } from './validation';
import {
	ModelOutputError,
	ModelProviderError,
	type GenerateCandidatesInput,
	type ModelProvider,
	type NormalizeEventInput,
} from './model-provider';
import { HOUSE_VOICE_CONTRACT } from './model-runner';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const OPENAI_MODEL = 'gpt-5.6-terra';
const INPUT_MICRO_USD_PER_TOKEN = 2;
const OUTPUT_MICRO_USD_PER_TOKEN = 12;
const NORMALIZATION_MAX_OUTPUT_TOKENS = 3_000;
const CANDIDATE_MAX_OUTPUT_TOKENS = 2_500;
const PROMPT_OVERHEAD_CHARACTERS = 6_000;

export type OpenAITransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const defaultOpenAITransport: OpenAITransport = (input, init) => fetch(input, init);

const sourceLinkSchema = {
	type: 'object', additionalProperties: false,
	properties: {
		sourceReferenceId: { type: 'string', minLength: 1, maxLength: 100 },
		relationship: { type: 'string', enum: ['SUPPORTS', 'CONTRADICTS', 'CONTEXT'] },
	},
	required: ['sourceReferenceId', 'relationship'],
} as const;

export const NORMALIZATION_SCHEMA = {
	type: 'object', additionalProperties: false,
	properties: {
		eventStatement: { type: 'string', minLength: 1, maxLength: 1_000 },
		assertions: { type: 'array', minItems: 1, maxItems: 30, items: {
			type: 'object', additionalProperties: false,
			properties: {
				kind: { type: 'string', enum: ['FACT', 'UNCERTAINTY', 'CONTEXT'] },
				statement: { type: 'string', minLength: 1, maxLength: 2_000 },
				sources: { type: 'array', items: sourceLinkSchema },
			},
			required: ['kind', 'statement', 'sources'],
		} },
		proposedSignificanceScore: { type: 'integer', minimum: 1, maximum: 5 },
		proposedSatirePotentialScore: { type: 'integer', minimum: 1, maximum: 5 },
		proposedSuitability: { type: 'string', enum: ['UNREVIEWED', 'SUITABLE', 'SENSITIVE', 'UNSUITABLE'] },
		suitabilityReason: { type: 'string', minLength: 1, maxLength: 2_000 },
		guardrailFlags: { type: 'array', uniqueItems: true, items: { type: 'string', enum: [
			'DEATH_OR_CASUALTY', 'ACTIVE_EMERGENCY', 'IDENTIFIABLE_VICTIM', 'CHILD_VICTIM',
			'SELF_HARM', 'SEXUAL_VIOLENCE', 'SERIOUS_MEDICAL_CRISIS', 'UNRESOLVED_ALLEGATION',
			'POLITICAL_PARTISAN_FRAMING',
		] } },
	},
	required: ['eventStatement', 'assertions', 'proposedSignificanceScore', 'proposedSatirePotentialScore', 'proposedSuitability', 'suitabilityReason', 'guardrailFlags'],
} as const;

export const CANDIDATE_SCHEMA = {
	type: 'object', additionalProperties: false,
	properties: {
		candidates: { type: 'array', minItems: 5, maxItems: 5, items: {
			type: 'object', additionalProperties: false,
			properties: {
				headline: { type: 'string', minLength: 1, maxLength: 300 },
				deck: { type: 'string', maxLength: 1_000 },
				rationale: { type: 'string', minLength: 1, maxLength: 2_000 },
				satiricalMechanism: { type: 'string', minLength: 1, maxLength: 120 },
			},
			required: ['headline', 'deck', 'rationale', 'satiricalMechanism'],
		} },
	},
	required: ['candidates'],
} as const;

interface OpenAIResponse {
	status: string;
	model?: string;
	output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

function safeSourceInput(input: NormalizeEventInput) {
	return {
		title: input.title,
		neutralBrief: input.neutralBrief,
		references: input.references.map((reference) => ({
			id: reference.id,
			sourceTitle: reference.sourceTitle,
			publisherName: reference.publisherName,
			sourceTier: reference.sourceTier,
			sourceType: reference.sourceType,
			publishedAt: reference.publishedAt,
		})),
	};
}

function responseText(response: OpenAIResponse): string {
	if (response.status !== 'completed' || !Array.isArray(response.output)) throw new ModelOutputError();
	const texts = response.output.flatMap((item) => item.type === 'message' && Array.isArray(item.content)
		? item.content.filter((content) => content.type === 'output_text' && typeof content.text === 'string').map((content) => content.text as string)
		: []);
	if (texts.length !== 1) throw new ModelOutputError();
	return texts[0];
}

function nonnegativeInteger(value: unknown): number {
	if (!Number.isInteger(value) || (value as number) < 0) throw new ModelOutputError('Provider usage metadata is invalid.');
	return value as number;
}

function httpFailure(status: number): ModelProviderError {
	if (status === 401 || status === 403) return new ModelProviderError('PROVIDER_AUTHENTICATION', false);
	if (status === 429) return new ModelProviderError('PROVIDER_RATE_LIMIT', true);
	if (status >= 500) return new ModelProviderError('PROVIDER_SERVER', true);
	return new ModelProviderError('PROVIDER_REQUEST', false);
}

export class OpenAIModelProvider implements ModelProvider {
	readonly providerId = 'openai';

	constructor(
		private readonly apiKey: string,
		readonly modelId = OPENAI_MODEL,
		private readonly transport: OpenAITransport = defaultOpenAITransport,
	) {
		if (!apiKey.trim()) throw new ModelProviderError('PROVIDER_CONFIGURATION', false);
		if (modelId !== OPENAI_MODEL) throw new ModelProviderError('PROVIDER_CONFIGURATION', false);
	}

	estimateMaximumCostMicrousd(operation: ModelOperation, inputCharacters: number): number {
		const conservativeInputTokens = Math.max(0, inputCharacters) + PROMPT_OVERHEAD_CHARACTERS;
		const outputTokens = operation === 'NORMALIZE' ? NORMALIZATION_MAX_OUTPUT_TOKENS : CANDIDATE_MAX_OUTPUT_TOKENS;
		return conservativeInputTokens * INPUT_MICRO_USD_PER_TOKEN + outputTokens * OUTPUT_MICRO_USD_PER_TOKEN;
	}

	async normalizeEvent(input: NormalizeEventInput, signal: AbortSignal): Promise<ModelResult<NormalizationProposal>> {
		const providerInput = safeSourceInput(input);
		return this.request(
			'NORMALIZE',
			'Normalize only the editor-provided event brief. Separate FACT, UNCERTAINTY, and CONTEXT assertions. Cite source-reference IDs for every assertion. Context-only sources cannot independently support facts. Propose, but never finalize, scores, suitability, and guardrails.',
			providerInput,
			'normalized_event',
			NORMALIZATION_SCHEMA,
			(value) => parseNormalizationProposal(value),
			signal,
		);
	}

	async generateCandidates(input: GenerateCandidatesInput, signal: AbortSignal): Promise<ModelResult<CandidateProposal[]>> {
		if (input.count !== 5) throw new ModelOutputError('OpenAI candidate generation requires exactly five candidates.');
		const instructions = `${HOUSE_VOICE_CONTRACT} The approved voice references are Committee Forms Smaller Committee to Find Out Who Is Chairing Committee; Moon Requests Meeting About Boundaries; Coffee Chain Announces Subscription Tier for Waiting in Line; and Cloud Apologizes for Looking Like Something. Treat them only as tonal references and do not imitate their sentence structures. Produce alternatives, not an article body.`;
		return this.request('GENERATE_CANDIDATES', instructions, input, 'satire_candidates', CANDIDATE_SCHEMA, (value) => {
			if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelOutputError();
			return parseCandidateBatch((value as { candidates?: unknown }).candidates, 5);
		}, signal);
	}

	private async request<T>(
		operation: ModelOperation,
		instructions: string,
		input: unknown,
		schemaName: string,
		schema: object,
		validate: (value: unknown) => T,
		signal: AbortSignal,
	): Promise<ModelResult<T>> {
		const inputText = JSON.stringify(input);
		let response: Response;
		try {
			response = await this.transport(OPENAI_RESPONSES_URL, {
				method: 'POST', signal,
				headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: this.modelId,
					store: false,
					tools: [],
					tool_choice: 'none',
					parallel_tool_calls: false,
					reasoning: { effort: 'none' },
					max_output_tokens: operation === 'NORMALIZE' ? NORMALIZATION_MAX_OUTPUT_TOKENS : CANDIDATE_MAX_OUTPUT_TOKENS,
					instructions,
					input: inputText,
					text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
				}),
			});
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') throw error;
			throw new ModelProviderError('PROVIDER_NETWORK', true);
		}
		if (!response.ok) throw httpFailure(response.status);
		let envelope: OpenAIResponse;
		try { envelope = await response.json() as OpenAIResponse; }
		catch { throw new ModelOutputError(); }
		const text = responseText(envelope);
		let rawOutput: unknown;
		try { rawOutput = JSON.parse(text); }
		catch { throw new ModelOutputError(); }
		const output = validate(rawOutput);
		const inputTokens = nonnegativeInteger(envelope.usage?.input_tokens);
		const outputTokens = nonnegativeInteger(envelope.usage?.output_tokens);
		return {
			provider: this.providerId,
			model: this.modelId,
			providerRevision: typeof envelope.model === 'string' ? envelope.model : null,
			output,
			usage: {
				inputTokens,
				outputTokens,
				inputCharacters: inputText.length,
				outputCharacters: text.length,
				estimatedCostMicrousd: inputTokens * INPUT_MICRO_USD_PER_TOKEN + outputTokens * OUTPUT_MICRO_USD_PER_TOKEN,
			},
		};
	}
}
