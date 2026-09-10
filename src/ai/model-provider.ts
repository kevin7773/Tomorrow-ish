import type {
	CandidateProposal,
	ModelResult,
	NormalizationProposal,
} from '../domain/generation';
import type { SourceReference } from '../domain/editorial';

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
}

export class ModelOutputError extends Error {
	constructor(message = 'The model returned invalid structured output.') {
		super(message);
		this.name = 'ModelOutputError';
	}
}
