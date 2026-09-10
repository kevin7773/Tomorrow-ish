import type {
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

export interface ModelProvider {
	readonly providerId: string;
	readonly modelId: string;
	normalizeEvent(input: NormalizeEventInput, signal: AbortSignal): Promise<ModelResult<NormalizationProposal>>;
	generateCandidates(
		input: GenerateCandidatesInput,
		signal: AbortSignal,
	): Promise<ModelResult<CandidateProposal[]>>;
	estimateMaximumCostMicrousd(operation: ModelOperation, inputCharacters: number): number;
}

export class ModelOutputError extends Error {
	constructor(message = 'The model returned invalid structured output.') {
		super(message);
		this.name = 'ModelOutputError';
	}
}

export class ModelProviderError extends Error {
	constructor(
		readonly failureClassification: string,
		readonly retryable: boolean,
		message = 'The model provider request failed.',
	) {
		super(message);
		this.name = 'ModelProviderError';
	}
}
