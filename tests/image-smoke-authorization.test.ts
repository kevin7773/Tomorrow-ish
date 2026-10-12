import { describe, expect, it, vi } from 'vitest';
import type { EditorialWorkflowRepository } from '../src/data/editorial-workflow-repository';
import { authorizeImageSmokeTarget } from '../src/services/image-smoke-authorization';
import { smokeTarget, SMOKE_BATCH_ID, SMOKE_CANDIDATE_ID, SMOKE_INTAKE_ID, SMOKE_NORMALIZATION_ID, SMOKE_STORY_ID } from '../src/services/editorial-smoke-target';

const target = smokeTarget(SMOKE_BATCH_ID, SMOKE_INTAKE_ID)!;

function repository(overrides: Record<string, unknown> = {}): EditorialWorkflowRepository {
	return {
		findItem: vi.fn(async () => ({
			batchId: SMOKE_BATCH_ID, intakeId: SMOKE_INTAKE_ID, storyId: SMOKE_STORY_ID,
			candidateId: SMOKE_CANDIDATE_ID,
		})),
		findCandidateSelection: vi.fn(async () => ({
			batchId: SMOKE_BATCH_ID, intakeId: SMOKE_INTAKE_ID, candidateId: SMOKE_CANDIDATE_ID,
			normalizedEventVersionId: SMOKE_NORMALIZATION_ID,
		})),
		isAcceptedNormalization: vi.fn(async () => true),
		...overrides,
	} as unknown as EditorialWorkflowRepository;
}

describe('exact image smoke authorization', () => {
	it('requires the exact workflow story, selected candidate, and accepted normalization', async () => {
		await expect(authorizeImageSmokeTarget(repository(), target)).resolves.toBe(true);
	});

	it.each([
		['batch', { findItem: vi.fn(async () => ({ batchId: 'other', intakeId: SMOKE_INTAKE_ID, storyId: SMOKE_STORY_ID, candidateId: SMOKE_CANDIDATE_ID })) }],
		['intake', { findItem: vi.fn(async () => ({ batchId: SMOKE_BATCH_ID, intakeId: 'other', storyId: SMOKE_STORY_ID, candidateId: SMOKE_CANDIDATE_ID })) }],
		['story', { findItem: vi.fn(async () => ({ batchId: SMOKE_BATCH_ID, intakeId: SMOKE_INTAKE_ID, storyId: 'other', candidateId: SMOKE_CANDIDATE_ID })) }],
		['candidate', { findCandidateSelection: vi.fn(async () => ({ batchId: SMOKE_BATCH_ID, intakeId: SMOKE_INTAKE_ID, candidateId: 'other', normalizedEventVersionId: SMOKE_NORMALIZATION_ID })) }],
		['normalization', { findCandidateSelection: vi.fn(async () => ({ batchId: SMOKE_BATCH_ID, intakeId: SMOKE_INTAKE_ID, candidateId: SMOKE_CANDIDATE_ID, normalizedEventVersionId: 'other' })) }],
		['acceptance', { isAcceptedNormalization: vi.fn(async () => false) }],
	] as const)('fails closed for mismatched %s evidence', async (_name, overrides) => {
		await expect(authorizeImageSmokeTarget(repository(overrides), target)).resolves.toBe(false);
	});
});
