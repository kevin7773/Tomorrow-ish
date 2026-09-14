import type { ArticleBodyProposal, CandidateProposal, ModelOperation, ModelResult, NormalizationProposal } from '../domain/generation';
import { parseArticleBodyProposal, parseCandidateBatch, parseNormalizationProposal } from './validation';
import {
	ModelOutputError,
	ModelProviderError,
	type ProviderResponseDiagnostics,
	type GenerateArticleBodyInput,
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
const ARTICLE_BODY_MAX_OUTPUT_TOKENS = 3_000;
const PROMPT_OVERHEAD_CHARACTERS = 6_000;

export type OpenAITransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const defaultOpenAITransport: OpenAITransport = (input, init) => fetch(input, init);

const sourceLinkSchema = {
	type: 'object', additionalProperties: false,
	properties: {
		sourceReferenceId: { type: 'string' },
		relationship: { type: 'string', enum: ['SUPPORTS', 'CONTRADICTS', 'CONTEXT'] },
	},
	required: ['sourceReferenceId', 'relationship'],
} as const;

export const NORMALIZATION_SCHEMA = {
	type: 'object', additionalProperties: false,
	properties: {
		eventStatement: { type: 'string' },
		assertions: { type: 'array', minItems: 1, maxItems: 30, items: {
			type: 'object', additionalProperties: false,
			properties: {
				kind: { type: 'string', enum: ['FACT', 'UNCERTAINTY', 'CONTEXT'] },
				statement: { type: 'string' },
				sources: { type: 'array', items: sourceLinkSchema },
			},
			required: ['kind', 'statement', 'sources'],
		} },
		proposedSignificanceScore: { type: 'integer', minimum: 1, maximum: 5 },
		proposedSatirePotentialScore: { type: 'integer', minimum: 1, maximum: 5 },
		proposedSuitability: { type: 'string', enum: ['UNREVIEWED', 'SUITABLE', 'SENSITIVE', 'UNSUITABLE'] },
		suitabilityReason: { type: 'string' },
		guardrailFlags: { type: 'array', items: { type: 'string', enum: [
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
				headline: { type: 'string' },
				deck: { type: 'string' },
				rationale: { type: 'string' },
				satiricalMechanism: { type: 'string' },
			},
			required: ['headline', 'deck', 'rationale', 'satiricalMechanism'],
		} },
	},
	required: ['candidates'],
} as const;

export const ARTICLE_BODY_SCHEMA = {
	type: 'object', additionalProperties: false,
	properties: {
		body_markdown: { type: 'string' },
		factual_assertion_ids_used: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string' } },
		satire_framing_summary: { type: 'string' },
		safety_notes: { type: 'array', maxItems: 20, items: { type: 'string' } },
	},
	required: ['body_markdown', 'factual_assertion_ids_used', 'satire_framing_summary', 'safety_notes'],
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

const MAX_PROVIDER_ERROR_BODY_CHARACTERS = 64_000;
const MAX_PROVIDER_MESSAGE_CHARACTERS = 500;

function safeIdentifier(value: unknown, maxLength = 200): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= maxLength && /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

function safeHeader(value: string | null, maxLength = 200): string | null {
	if (value === null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= maxLength && /^[\x20-\x7E]+$/.test(trimmed) ? trimmed : null;
}

function sanitizedProviderMessage(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const sanitized = value
		.replace(/[\u0000-\u001F\u007F]/g, ' ')
		.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
		.replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]')
		.replace(/\s+/g, ' ')
		.trim();
	return sanitized ? sanitized.slice(0, MAX_PROVIDER_MESSAGE_CHARACTERS) : null;
}

async function responseDiagnostics(response: Response): Promise<ProviderResponseDiagnostics> {
	let errorType: string | null = null;
	let errorCode: string | null = null;
	let errorMessage: string | null = null;
	try {
		const raw = await response.text();
		if (raw.length <= MAX_PROVIDER_ERROR_BODY_CHARACTERS) {
			const envelope: unknown = JSON.parse(raw);
			if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
				const error = (envelope as { error?: unknown }).error;
				if (error && typeof error === 'object' && !Array.isArray(error)) {
					errorType = safeIdentifier((error as { type?: unknown }).type);
					errorCode = safeIdentifier((error as { code?: unknown }).code);
					errorMessage = sanitizedProviderMessage((error as { message?: unknown }).message);
				}
			}
		}
	} catch {
		// An absent or malformed provider error body intentionally yields metadata-only diagnostics.
	}
	return {
		httpStatus: response.status,
		errorType,
		errorCode,
		errorMessage,
		requestId: safeIdentifier(response.headers.get('x-request-id')),
		retryAfter: safeHeader(response.headers.get('retry-after'), 100),
	};
}

async function httpFailure(response: Response): Promise<ModelProviderError> {
	const diagnostics = await responseDiagnostics(response);
	const status = response.status;
	if (status === 401 || status === 403) return new ModelProviderError('PROVIDER_AUTHENTICATION', false, undefined, diagnostics);
	if (status === 429) return new ModelProviderError('PROVIDER_RATE_LIMIT', true, undefined, diagnostics);
	if (status >= 500) return new ModelProviderError('PROVIDER_SERVER', true, undefined, diagnostics);
	return new ModelProviderError('PROVIDER_REQUEST', false, undefined, diagnostics);
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
		const outputTokens = operation === 'NORMALIZE'
			? NORMALIZATION_MAX_OUTPUT_TOKENS
			: operation === 'GENERATE_ARTICLE_BODY' ? ARTICLE_BODY_MAX_OUTPUT_TOKENS : CANDIDATE_MAX_OUTPUT_TOKENS;
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

	async generateArticleBody(input: GenerateArticleBodyInput, signal: AbortSignal): Promise<ModelResult<ArticleBodyProposal>> {
		const instructions = `${HOUSE_VOICE_CONTRACT} Write one complete, original Tomorrow-ish satirical news article using the selected headline, deck, category, and framing without changing them. Return four to seven short, substantive prose paragraphs in Markdown with a clear setup, escalation, and closing beat. Use only the supplied source facts and accepted normalized FACT assertions as real-world factual substrate. Return factual_assertion_ids_used containing only the immutable IDs of FACT assertions actually used; never return assertion text in that field, and never select CONTEXT or UNCERTAINTY IDs. Do not introduce unsupported names, ages, locations, charges, chronology, statistics, quotations, expert claims, or institutional statements. Preserve attribution for uncertainties, allegations, arrests, charges, and disputed claims; never imply guilt. Never fabricate quotations, expert statements, motives, or source details. Satirical narration must remain clearly separable from sourced facts and must follow the persisted editorial caution direction. Do not intensify sexual, violent, criminal, defamatory, humiliating, or tragic framing. Direct satire toward the persisted editorial target, not a person accused of unresolved conduct. Do not copy source prose, add headings, write an outline, preface the output with meta commentary, mention these instructions, or include placeholder text.`;
		return this.request(
			'GENERATE_ARTICLE_BODY',
			instructions,
			input,
			'article_body',
			ARTICLE_BODY_SCHEMA,
			parseArticleBodyProposal,
			signal,
		);
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
					max_output_tokens: operation === 'NORMALIZE'
						? NORMALIZATION_MAX_OUTPUT_TOKENS
						: operation === 'GENERATE_ARTICLE_BODY' ? ARTICLE_BODY_MAX_OUTPUT_TOKENS : CANDIDATE_MAX_OUTPUT_TOKENS,
					instructions,
					input: inputText,
					text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
				}),
			});
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') throw error;
			throw new ModelProviderError('PROVIDER_NETWORK', true);
		}
		if (!response.ok) throw await httpFailure(response);
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
			providerRequestId: safeIdentifier(response.headers.get('x-request-id')),
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
