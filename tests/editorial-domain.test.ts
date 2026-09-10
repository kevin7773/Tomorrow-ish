import { describe, expect, it } from 'vitest';
import {
	CANDIDATE_STATUSES,
	canTransitionCandidate,
	isCandidateStatus,
	isValidSourceAuthority,
} from '../src/domain/editorial';

describe('M2 editorial domain', () => {
	it('keeps significance and satire potential on an independent fixed scale', () => {
		const significantUnsuitableEvent = {
			significanceScore: 5,
			satirePotentialScore: 1,
			satireSuitability: 'UNSUITABLE',
		};
		expect(significantUnsuitableEvent).toEqual({
			significanceScore: 5,
			satirePotentialScore: 1,
			satireSuitability: 'UNSUITABLE',
		});
	});

	it('requires social and community sources to remain context-only', () => {
		expect(isValidSourceAuthority('CONTEXT_ONLY', 'SOCIAL_CONTEXT')).toBe(true);
		expect(isValidSourceAuthority('TIER_1', 'SOCIAL_CONTEXT')).toBe(false);
		expect(isValidSourceAuthority('TIER_2', 'COMMUNITY_CONTEXT')).toBe(false);
	});

	it('uses an explicit candidate review path with no publication state', () => {
		expect(CANDIDATE_STATUSES).toEqual(['DRAFT', 'REVIEW', 'APPROVED', 'REJECTED']);
		expect(isCandidateStatus('PUBLISHED')).toBe(false);
		expect(canTransitionCandidate('DRAFT', 'REVIEW')).toBe(true);
		expect(canTransitionCandidate('REVIEW', 'APPROVED')).toBe(true);
		expect(canTransitionCandidate('APPROVED', 'REVIEW')).toBe(true);
	});
});
