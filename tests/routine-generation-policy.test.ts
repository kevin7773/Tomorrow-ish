import { describe, expect, it } from 'vitest';
import type { NormalizedEventVersion } from '../src/domain/generation';
import {
	evaluateRoutineNormalization,
	ROUTINE_CANDIDATE_SELECTION_REASON,
	ROUTINE_GENERATION_POLICY,
	ROUTINE_NORMALIZATION_ACCEPTANCE_REASON,
} from '../src/services/routine-generation-policy';

function version(overrides: Partial<NormalizedEventVersion> = {}): NormalizedEventVersion {
	return {
		id: 'version-1', sourceIntakeId: 'intake-1', parentVersionId: null, versionNumber: 1,
		reviewState: 'PROPOSED', origin: 'MODEL', modelRunId: 'run-1',
		eventStatement: 'A verified event occurred.', proposedSignificanceScore: 3,
		proposedSatirePotentialScore: 4, proposedSuitability: 'SUITABLE',
		suitabilityReason: 'Institutional absurdity with a public-interest angle.', guardrailFlags: [],
		createdByEmail: 'automation@tomorrow-ish.news', reviewedByEmail: null,
		reviewReason: null, createdAt: '2026-10-13T12:00:00.000Z', reviewedAt: null,
		assertions: [{ id: 'fact-1', kind: 'FACT', statement: 'Verified fact.',
			sources: [{ sourceReferenceId: 'source-1', relationship: 'SUPPORTS' }] }],
		...overrides,
	};
}

describe('routine generation governance policy', () => {
	it('allows only a model-origin suitable proposal with facts and no guardrail flags', () => {
		expect(evaluateRoutineNormalization(version())).toEqual({ allowed: true });
	});

	it.each([
		['editor-authored', { origin: 'EDITOR' as const, modelRunId: null }, 'NORMALIZATION_NOT_MODEL_ORIGIN'],
		['sensitive', { proposedSuitability: 'SENSITIVE' as const }, 'NORMALIZATION_REQUIRES_EDITORIAL_REVIEW'],
		['unsuitable', { proposedSuitability: 'UNSUITABLE' as const }, 'NORMALIZATION_REQUIRES_EDITORIAL_REVIEW'],
		['guardrail', { guardrailFlags: ['UNRESOLVED_ALLEGATION'] }, 'NORMALIZATION_GUARDRAIL_REVIEW_REQUIRED'],
		['no facts', { assertions: [] }, 'NORMALIZATION_FACT_SUPPORT_REQUIRED'],
	] as const)('fails closed for %s normalization', (_label, overrides, classification) => {
		expect(evaluateRoutineNormalization(version(overrides as Partial<NormalizedEventVersion>)))
			.toEqual({ allowed: false, classification });
	});

	it('uses stable, reviewable governance evidence', () => {
		expect(ROUTINE_GENERATION_POLICY).toBe('routine-generation:v1');
		expect(ROUTINE_NORMALIZATION_ACCEPTANCE_REASON).toContain(ROUTINE_GENERATION_POLICY);
		expect(ROUTINE_CANDIDATE_SELECTION_REASON).toContain(ROUTINE_GENERATION_POLICY);
	});
});
