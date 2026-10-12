import type {
	ArticleBodyProposal,
	CandidateProposal,
	ModelResult,
	NormalizationProposal,
} from '../domain/generation';
import type { SourceReference } from '../domain/editorial';
import type { ModelOperation } from '../domain/generation';

export interface NormalizeEventInput {
	title: string;
	neutralBrief: string;
	references: SourceReference[];
}

export interface GenerateCandidatesInput {
	eventStatement: string;
	facts: string[];
	uncertainties: string[];
	context: string[];
	suitabilityReason: string;
	guardrailFlags: string[];
	count: number;
}

export interface GenerateArticleBodyInput {
	source: {
		title: string;
		neutralBrief: string;
		significanceScore: number;
		satirePotentialScore: number;
		satireSuitability: string;
		suitabilityReason: string;
		guardrailFlags: string[];
		editorialNotes: string;
		references: Array<{
			id: string;
			sourceTitle: string;
			sourceUrl: string;
			publisherName: string;
			sourceTier: string;
			sourceType: string;
			publishedAt: string | null;
		}>;
	};
	normalizedEvent: {
		id: string;
		eventStatement: string;
		proposedSuitability: string;
		suitabilityReason: string;
		guardrailFlags: string[];
		assertions: Array<{
			id: string;
			kind: string;
			statement: string;
			sources: Array<{ sourceReferenceId: string; relationship: string }>;
		}>;
		reviewReason: string | null;
	};
	candidate: {
		headline: string;
		deck: string;
		rationale: string;
		satiricalMechanism: string;
		category: string;
		editorialNotes: string;
	};
	governance: {
		sensitive: boolean;
		unresolvedAllegation: boolean;
		editorialCautionReason: string | null;
	};
}

export interface ModelProvider {
	readonly providerId: string;
	readonly modelId: string;
	normalizeEvent(input: NormalizeEventInput, signal: AbortSignal): Promise<ModelResult<NormalizationProposal>>;
	generateCandidates(
		input: GenerateCandidatesInput,
		signal: AbortSignal,
	): Promise<ModelResult<CandidateProposal[]>>;
	generateArticleBody(
		input: GenerateArticleBodyInput,
		signal: AbortSignal,
	): Promise<ModelResult<ArticleBodyProposal>>;
	estimateMaximumCostMicrousd(operation: ModelOperation, inputCharacters: number): number;
}

export interface ModelProviderAccess {
	readonly providerId: string;
	readonly modelId: string;
	estimateMaximumCostMicrousd(operation: ModelOperation, inputCharacters: number): number;
	createProvider(): ModelProvider;
}

export function existingModelProvider(provider: ModelProvider): ModelProviderAccess {
	return {
		providerId: provider.providerId,
		modelId: provider.modelId,
		estimateMaximumCostMicrousd: (operation, inputCharacters) =>
			provider.estimateMaximumCostMicrousd(operation, inputCharacters),
		createProvider: () => provider,
	};
}

export interface ProviderResponseDiagnostics {
	httpStatus: number;
	errorType: string | null;
	errorCode: string | null;
	errorMessage: string | null;
	requestId: string | null;
	retryAfter: string | null;
}

export const MODEL_OUTPUT_FAILURE_REASONS = [
	'ENVELOPE_STATUS',
	'OUTPUT_TEXT_SHAPE',
	'JSON_PARSE',
	'CONTRACT_VALIDATION',
	'USAGE_METADATA',
] as const;
export type ModelOutputFailureReason = (typeof MODEL_OUTPUT_FAILURE_REASONS)[number];

export interface ModelOutputDiagnostics {
	reason: ModelOutputFailureReason;
	requestId: string | null;
	envelopeStatus: string | null;
	outputCharacters: number | null;
	outputHash: string | null;
	failedField: string | null;
}

export class ModelOutputError extends Error {
	constructor(
		message = 'The model returned invalid structured output.',
		readonly reason: ModelOutputFailureReason = 'CONTRACT_VALIDATION',
		readonly failedField: string | null = null,
		readonly diagnostics: ModelOutputDiagnostics | null = null,
	) {
		super(message);
		this.name = 'ModelOutputError';
	}
}

export class ModelProviderError extends Error {
	constructor(
		readonly failureClassification: string,
		readonly retryable: boolean,
		message = 'The model provider request failed.',
		readonly responseDiagnostics: ProviderResponseDiagnostics | null = null,
	) {
		super(message);
		this.name = 'ModelProviderError';
	}
}
