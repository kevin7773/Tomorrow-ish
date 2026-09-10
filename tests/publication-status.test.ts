import { describe, expect, it } from 'vitest';
import { canTransitionPublication } from '../src/domain/publication-status';

describe('publication authority', () => {
	it('allows the reviewed approval and publication path', () => {
		expect(canTransitionPublication('DRAFT', 'REVIEW')).toBe(true);
		expect(canTransitionPublication('REVIEW', 'APPROVED')).toBe(true);
		expect(canTransitionPublication('APPROVED', 'PUBLISHED')).toBe(true);
	});

	it('does not allow drafts or review items to publish directly', () => {
		expect(canTransitionPublication('DRAFT', 'PUBLISHED')).toBe(false);
		expect(canTransitionPublication('REVIEW', 'PUBLISHED')).toBe(false);
	});

	it('treats archived stories as terminal in M0', () => {
		expect(canTransitionPublication('ARCHIVED', 'PUBLISHED')).toBe(false);
	});
});
