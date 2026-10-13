import type { NormalizedEventVersion } from '../domain/generation';

export const ROUTINE_GENERATION_POLICY = 'routine-generation:v1';
export const ROUTINE_AUTOMATION_ACTOR = 'automation@tomorrow-ish.news';
export const ROUTINE_NORMALIZATION_ACCEPTANCE_REASON =
	'Automatically accepted under routine-generation:v1: model-origin, suitable, authoritative facts, and no guardrail flags.';
export const ROUTINE_CANDIDATE_SELECTION_REASON =
	'Automatically selected under routine-generation:v1 because this run creates exactly one candidate.';

export type RoutineNormalizationDecision =
	| { allowed: true }
	| { allowed: false; classification: string };

export function evaluateRoutineNormalization(version: NormalizedEventVersion): RoutineNormalizationDecision {
	if (version.reviewState !== 'PROPOSED') {
		return { allowed: false, classification: 'NORMALIZATION_NOT_PROPOSED' };
	}
	if (version.origin !== 'MODEL' || !version.modelRunId) {
		return { allowed: false, classification: 'NORMALIZATION_NOT_MODEL_ORIGIN' };
	}
	if (version.proposedSuitability !== 'SUITABLE') {
		return { allowed: false, classification: 'NORMALIZATION_REQUIRES_EDITORIAL_REVIEW' };
	}
	if (version.guardrailFlags.length > 0) {
		return { allowed: false, classification: 'NORMALIZATION_GUARDRAIL_REVIEW_REQUIRED' };
	}
	if (!version.assertions.some((assertion) => assertion.kind === 'FACT')) {
		return { allowed: false, classification: 'NORMALIZATION_FACT_SUPPORT_REQUIRED' };
	}
	return { allowed: true };
}
