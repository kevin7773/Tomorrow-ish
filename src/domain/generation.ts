import type { SatireSuitability, SourceReference } from './editorial';

export const GUARDRAIL_FLAGS = [
	'DEATH_OR_CASUALTY',
	'ACTIVE_EMERGENCY',
	'IDENTIFIABLE_VICTIM',
	'CHILD_VICTIM',
	'SELF_HARM',
	'SEXUAL_VIOLENCE',
	'SERIOUS_MEDICAL_CRISIS',
	'UNRESOLVED_ALLEGATION',
	'POLITICAL_PARTISAN_FRAMING',
] as const;
export type GuardrailFlag = (typeof GUARDRAIL_FLAGS)[number];

export const ASSERTION_KINDS = ['FACT', 'UNCERTAINTY', 'CONTEXT'] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];
export const SOURCE_RELATIONSHIPS = ['SUPPORTS', 'CONTRADICTS', 'CONTEXT'] as const;
export type SourceRelationship = (typeof SOURCE_RELATIONSHIPS)[number];
export type NormalizedEventOrigin = 'EDITOR' | 'MODEL';
export type NormalizedEventReviewState = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED';
export type ModelOperation = 'NORMALIZE' | 'GENERATE_CANDIDATES' | 'GENERATE_ARTICLE_BODY';

export interface AssertionSourceLink {
	sourceReferenceId: string;
	relationship: SourceRelationship;
}

export interface NormalizedAssertion {
	id: string;
	kind: AssertionKind;
	statement: string;
	sources: AssertionSourceLink[];
}

export interface NormalizationProposal {
	eventStatement: string;
	assertions: Omit<NormalizedAssertion, 'id'>[];
	proposedSignificanceScore: number;
	proposedSatirePotentialScore: number;
	proposedSuitability: SatireSuitability;
	suitabilityReason: string;
	guardrailFlags: GuardrailFlag[];
}

export interface NormalizedEventVersion extends Omit<NormalizationProposal, 'assertions'> {
	id: string;
	sourceIntakeId: string;
	parentVersionId: string | null;
	versionNumber: number;
	reviewState: NormalizedEventReviewState;
	origin: NormalizedEventOrigin;
	modelRunId: string | null;
	createdByEmail: string;
	reviewedByEmail: string | null;
	reviewReason: string | null;
	createdAt: string;
	reviewedAt: string | null;
	assertions: NormalizedAssertion[];
}

export interface CandidateProposal {
	headline: string;
	deck: string;
	rationale: string;
	satiricalMechanism: string;
}

export interface ArticleBodyProposal {
	bodyMarkdown: string;
	factualAssertionIdsUsed: string[];
	satireFramingSummary: string;
	safetyNotes: string[];
}

export interface ModelUsage {
	inputTokens: number | null;
	outputTokens: number | null;
	inputCharacters: number;
	outputCharacters: number;
	estimatedCostMicrousd: number;
}

export interface ModelResult<T> {
	output: T;
	provider: string;
	model: string;
	providerRevision: string | null;
	providerRequestId?: string | null;
	usage: ModelUsage;
}

export interface ModelRun {
	id: string;
	operation: ModelOperation;
	status: 'SUCCEEDED' | 'FAILED';
	sourceIntakeId: string;
	normalizedEventVersionId: string | null;
	provider: string;
	model: string;
	providerRevision: string | null;
	promptVersion: string;
	inputHash: string;
	outputHash: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	inputCharacters: number;
	outputCharacters: number;
	latencyMs: number;
	retryCount: number;
	estimatedCostMicrousd: number;
	candidateCount: number;
	idempotencyKey: string;
	requestedByEmail: string;
	failureClassification: string | null;
	providerHttpStatus: number | null;
	providerErrorType: string | null;
	providerErrorCode: string | null;
	providerErrorMessage: string | null;
	providerRequestId: string | null;
	providerRetryAfter: string | null;
	createdAt: string;
	completedAt: string;
}

export function displaySuitability(value: SatireSuitability): string {
	return value === 'SENSITIVE' ? 'Caution' : value[0] + value.slice(1).toLowerCase();
}

export function hasAuthoritativeFactSupport(
	assertion: Pick<NormalizedAssertion, 'kind' | 'sources'>,
	references: SourceReference[],
): boolean {
	if (assertion.kind !== 'FACT') return true;
	return assertion.sources.some((link) => {
		const reference = references.find((candidate) => candidate.id === link.sourceReferenceId);
		return link.relationship === 'SUPPORTS' && reference?.sourceTier !== 'CONTEXT_ONLY';
	});
}

export function deterministicGuardrailFlags(text: string): GuardrailFlag[] {
	const normalized = text.toLowerCase();
	const rules: Array<[GuardrailFlag, RegExp]> = [
		['DEATH_OR_CASUALTY', /\b(death|died|dead|fatal|casualt(?:y|ies))\b/],
		['ACTIVE_EMERGENCY', /\b(active emergency|hostage|ongoing disaster|evacuation)\b/],
		['IDENTIFIABLE_VICTIM', /\b(victim|survivor)\b/],
		['CHILD_VICTIM', /\b(child|children|minor)\b.*\b(victim|injured|killed)\b/],
		['SELF_HARM', /\b(suicide|self-harm|self harm)\b/],
		['SEXUAL_VIOLENCE', /\b(sexual assault|sexual violence|rape)\b/],
		['SERIOUS_MEDICAL_CRISIS', /\b(critical condition|medical crisis|life-threatening)\b/],
		['UNRESOLVED_ALLEGATION', /\b(alleged|allegedly|unconfirmed|not independently confirmed)\b/],
		['POLITICAL_PARTISAN_FRAMING', /\b(democrat|republican|left-wing|right-wing|partisan)\b/],
	];
	return rules.filter(([, pattern]) => pattern.test(normalized)).map(([flag]) => flag);
}

export function mergeGuardrailFlags(
	deterministic: readonly GuardrailFlag[],
	proposed: readonly GuardrailFlag[],
): GuardrailFlag[] {
	return GUARDRAIL_FLAGS.filter((flag) => deterministic.includes(flag) || proposed.includes(flag));
}
