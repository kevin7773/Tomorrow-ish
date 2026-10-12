import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EditorialWorkflowRepository } from '../src/data/editorial-workflow-repository';
import type { EditorialBatchItem } from '../src/domain/editorial-workflow';
import { EditorialWorkflowService, type FinalReviewImagePort, type WorkflowPipelinePort } from '../src/services/editorial-workflow-service';
import { SMOKE_BATCH_ID, SMOKE_INTAKE_ID, smokeTarget } from '../src/services/editorial-smoke-target';

const identity = { email: 'Editor@Tomorrow-ish.news' };
const now = '2026-09-27T12:00:00.000Z';

function workflowItem(state: EditorialBatchItem['state'] = 'INGESTED'): EditorialBatchItem {
	return { batchId: 'batch-1', intakeId: 'intake-1', ordinal: 1, categoryId: 'cat-civic-life', state,
		selectedByEmail: state === 'INGESTED' ? null : identity.email.toLowerCase(), selectedAt: state === 'INGESTED' ? null : now,
		candidateId: state === 'GENERATING' ? 'candidate-1' : null,
		storyId: state === 'READY_FOR_REVIEW' ? 'story-1' : null,
		failureStage: state === 'FAILED' ? 'IMAGE' : null, failureClassification: state === 'FAILED' ? 'PROVIDER' : null,
		leaseOwner: null, leaseAcquiredAt: null, leaseExpiresAt: null, attemptCount: 0, retryAttempt: 0,
		createdAt: now, updatedAt: now };
}

function setup(initial = workflowItem()) {
	let item = initial;
	const events: string[] = [];
	const repository: EditorialWorkflowRepository = {
		listBatches: vi.fn(), findBatch: vi.fn(), findItem: vi.fn(async () => ({ ...item })),
		findCandidateSelection: vi.fn(async () => null), findCandidateSelectionContext: vi.fn(async () => null), selectCandidate: vi.fn(),
		claimProcessable: vi.fn(async ({ owner, at, leaseExpiresAt }) => {
			if (!['SELECTED', 'GENERATING'].includes(item.state)) return [];
			item = { ...item, state: 'GENERATING', leaseOwner: owner, leaseAcquiredAt: at, leaseExpiresAt, attemptCount: item.attemptCount + 1 };
			events.push('GENERATION_STARTED'); return [{ ...item }];
		}),
		renewLease: vi.fn(async () => true),
		reconcilePublished: vi.fn(async () => 0),
		select: vi.fn(async () => { if (item.state !== 'INGESTED') return false; item = { ...item, state: 'SELECTED', selectedByEmail: identity.email.toLowerCase(), selectedAt: now }; events.push('INTAKE_SELECTED'); return true; }),
		rejectIntake: vi.fn(async () => { if (item.state !== 'INGESTED') return false; item = { ...item, state: 'REJECTED' }; events.push('INTAKE_REJECTED'); return true; }),
		attachCandidate: vi.fn(), findGeneratedCandidateId: vi.fn(), findStoryIdByCandidate: vi.fn(), attachExistingStory: vi.fn(), ensureReviewStory: vi.fn(),
		markReady: vi.fn(async (_batch, _intake, storyId) => { item = { ...item, state: 'READY_FOR_REVIEW', storyId }; events.push('ARTICLE_READY_FOR_REVIEW'); return true; }),
		markFailed: vi.fn(async () => { item = { ...item, state: 'FAILED', failureStage: 'AUTOMATIC_GENERATION', failureClassification: 'PIPELINE_FAILURE' }; events.push('GENERATION_FAILED'); }),
		releaseLease: vi.fn(async () => true),
		retryFailed: vi.fn(async () => { if (item.state !== 'FAILED') return false; item = { ...item, state: 'SELECTED', failureStage: null, failureClassification: null }; return true; }),
		ensureFinalReminder: vi.fn(async () => item.state === 'READY_FOR_REVIEW'),
		findPublicationReadiness: vi.fn(async () => 'READY' as const),
		publishFinal: vi.fn(async () => { if (item.state !== 'READY_FOR_REVIEW') return false; item = { ...item, state: 'PUBLISHED' }; events.push('ARTICLE_PUBLISHED'); return true; }),
		rejectFinal: vi.fn(async () => { if (item.state !== 'READY_FOR_REVIEW') return false; item = { ...item, state: 'REJECTED' }; events.push('ARTICLE_REJECTED'); return true; }),
		recordEvent: vi.fn(async ({ kind }) => { events.push(kind); }),
	};
	const pipeline: WorkflowPipelinePort = { advance: vi.fn(async () => ({ storyId: 'story-1', ready: true })) };
	const images: FinalReviewImagePort = { regenerate: vi.fn(async () => undefined) };
	let id = 0;
	const service = new EditorialWorkflowService(repository, pipeline, images, { now: () => now, createId: () => `id-${++id}`, generationEnabled: true,
		smokeTarget: { batchId: 'batch-1', intakeId: 'intake-1' } });
	return { service, repository, pipeline, images, events, getItem: () => item };
}

describe('two-gate editorial workflow', () => {
	it('fails closed unless the exact single smoke batch/intake pair is configured', () => {
		expect(smokeTarget(SMOKE_BATCH_ID, SMOKE_INTAKE_ID)).toEqual({ batchId: SMOKE_BATCH_ID, intakeId: SMOKE_INTAKE_ID });
		expect(smokeTarget(undefined, undefined)).toBeNull();
		expect(smokeTarget(SMOKE_BATCH_ID, undefined)).toBeNull();
		expect(smokeTarget(`${SMOKE_BATCH_ID}-other`, SMOKE_INTAKE_ID)).toBeNull();
		expect(smokeTarget(SMOKE_BATCH_ID, `${SMOKE_INTAKE_ID},another`)).toBeNull();
	});
	it('demonstrates a complete three-item session with no hidden intermediate human gate', async () => {
		const items = new Map(['intake-1', 'intake-2', 'intake-3'].map((intakeId, index) => [intakeId, {
			...workflowItem(), intakeId, ordinal: index + 1,
		}]));
		const events: string[] = [];
		const repository: EditorialWorkflowRepository = {
			listBatches: vi.fn(), findBatch: vi.fn(),
			findCandidateSelection: vi.fn(async () => null), findCandidateSelectionContext: vi.fn(async () => null), selectCandidate: vi.fn(),
			findItem: vi.fn(async (_batchId, intakeId) => ({ ...items.get(intakeId)! })),
			claimProcessable: vi.fn(async ({ owner, at, leaseExpiresAt, limit, target }) => [...items.values()]
				.filter((item) => ['SELECTED', 'GENERATING'].includes(item.state)
					&& (!target || (item.batchId === target.batchId && item.intakeId === target.intakeId))).slice(0, limit).map((item) => {
					const claimed = { ...item, state: 'GENERATING' as const, leaseOwner: owner, leaseAcquiredAt: at,
						leaseExpiresAt, attemptCount: item.attemptCount + 1 }; items.set(item.intakeId, claimed);
					events.push('GENERATION_STARTED'); return { ...claimed };
				})),
			renewLease: vi.fn(async () => true), reconcilePublished: vi.fn(async () => 0),
			select: vi.fn(async (_batchId, intakeId) => { const item = items.get(intakeId)!; if (item.state !== 'INGESTED') return false; items.set(intakeId, { ...item, state: 'SELECTED', selectedByEmail: identity.email.toLowerCase(), selectedAt: now }); events.push('INTAKE_SELECTED'); return true; }),
			rejectIntake: vi.fn(async (_batchId, intakeId) => { const item = items.get(intakeId)!; if (item.state !== 'INGESTED') return false; items.set(intakeId, { ...item, state: 'REJECTED' }); events.push('INTAKE_REJECTED'); return true; }),
			attachCandidate: vi.fn(), findGeneratedCandidateId: vi.fn(), findStoryIdByCandidate: vi.fn(), attachExistingStory: vi.fn(), ensureReviewStory: vi.fn(),
			markReady: vi.fn(async (_batchId, intakeId, storyId) => { const item = items.get(intakeId)!; items.set(intakeId, { ...item, state: 'READY_FOR_REVIEW', storyId }); events.push('ARTICLE_READY_FOR_REVIEW'); return true; }),
			markFailed: vi.fn(), releaseLease: vi.fn(async () => true), retryFailed: vi.fn(), ensureFinalReminder: vi.fn(async () => true),
			findPublicationReadiness: vi.fn(async () => 'READY' as const),
			publishFinal: vi.fn(async ({ intakeId }) => { const item = items.get(intakeId)!; items.set(intakeId, { ...item, state: 'PUBLISHED' }); events.push('ARTICLE_PUBLISHED'); return true; }),
			rejectFinal: vi.fn(async ({ intakeId }) => { const item = items.get(intakeId)!; items.set(intakeId, { ...item, state: 'REJECTED' }); events.push('ARTICLE_REJECTED'); return true; }),
			recordEvent: vi.fn(async ({ kind }) => { events.push(kind); }),
		};
		const pipeline: WorkflowPipelinePort = { advance: vi.fn(async (item) => ({ storyId: `story-${item.intakeId.at(-1)}`, ready: true })) };
		const images: FinalReviewImagePort = { regenerate: vi.fn(async () => undefined) };
		let id = 0;
		const service = new EditorialWorkflowService(repository, pipeline, images, { now: () => now, createId: () => `demo-${++id}`, generationEnabled: true,
			smokeTarget: { batchId: 'batch-1', intakeId: 'intake-1' } });

		await service.triage(identity, 'batch-1', ['intake-1', 'intake-2'], 'SELECT');
		await service.triage(identity, 'batch-1', ['intake-3'], 'REJECT');
		expect(await service.process()).toEqual({ reconciled: 0, ready: 1, pending: 0, failed: 0 });
		expect(pipeline.advance).toHaveBeenCalledTimes(1);
		expect([...items.values()].map((item) => item.state)).toEqual(['READY_FOR_REVIEW', 'SELECTED', 'REJECTED']);

		await service.recordEdit(identity, 'batch-1', 'intake-1', 'story-1');
		await service.publish(identity, 'batch-1', 'intake-1', 'PUBLISH');
		expect([...items.values()].map((item) => item.state)).toEqual(['PUBLISHED', 'SELECTED', 'REJECTED']);
		expect([...items.values()].filter((item) => item.state === 'READY_FOR_REVIEW')).toHaveLength(0);
		expect(events).toContain('ARTICLE_EDITED');
		expect(events).not.toContain('IMAGE_REGENERATED');
	});

	it('rejecting at Gate 1 prevents generation', async () => {
		const test = setup(); await test.service.triage(identity, 'batch-1', ['intake-1'], 'REJECT'); await test.service.process();
		expect(test.getItem().state).toBe('REJECTED'); expect(test.pipeline.advance).not.toHaveBeenCalled();
	});

	it('keeps provider work disabled while still allowing state-only reconciliation', async () => {
		const test = setup(workflowItem('GENERATING'));
		vi.mocked(test.repository.reconcilePublished).mockResolvedValueOnce(1);
		const gated = new EditorialWorkflowService(test.repository, test.pipeline, test.images, {
			now: () => now, createId: () => 'reconcile-id', generationEnabled: false,
		});
		expect(await gated.process()).toEqual({ reconciled: 1, ready: 0, pending: 0, failed: 0 });
		expect(test.repository.claimProcessable).not.toHaveBeenCalled();
		expect(test.pipeline.advance).not.toHaveBeenCalled();
	});

	it('selection automatically progresses through generation to final review without another human gate', async () => {
		const test = setup(); await test.service.triage(identity, 'batch-1', ['intake-1'], 'SELECT');
		expect(await test.service.process()).toMatchObject({ ready: 1, failed: 0 });
		expect(test.events).toEqual(['INTAKE_SELECTED', 'GENERATION_STARTED', 'ARTICLE_READY_FOR_REVIEW']);
		expect(test.repository.ensureFinalReminder).toHaveBeenCalledWith('batch-1', now, expect.any(String));
	});

	it('scopes image-free readiness to an image-disabled exact smoke target', async () => {
		const exact = setup(workflowItem('SELECTED'));
		const imageDisabled = new EditorialWorkflowService(exact.repository, exact.pipeline, exact.images, {
			now: () => now, createId: () => 'image-free-ready', generationEnabled: true,
			smokeTarget: { batchId: 'batch-1', intakeId: 'intake-1' }, imageGenerationEnabled: false,
		});
		await imageDisabled.process();
		expect(exact.repository.markReady).toHaveBeenCalledWith(
			'batch-1', 'intake-1', 'story-1', expect.any(String), now, 'image-free-ready', true,
		);

		const imageRequired = setup(workflowItem('SELECTED'));
		await imageRequired.service.process();
		expect(imageRequired.repository.markReady).toHaveBeenCalledWith(
			'batch-1', 'intake-1', 'story-1', expect.any(String), now, expect.any(String), false,
		);
	});

	it('requires explicit publication and blocks incomplete final packages without approving an image', async () => {
		const test = setup(workflowItem('READY_FOR_REVIEW'));
		await expect(test.service.publish(identity, 'batch-1', 'intake-1', '')).rejects.toThrow(/PUBLISH/);
		expect(test.repository.publishFinal).not.toHaveBeenCalled();
		vi.mocked(test.repository.findPublicationReadiness).mockResolvedValueOnce('IMAGE_REQUIRED');
		await expect(test.service.publish(identity, 'batch-1', 'intake-1', 'PUBLISH'))
			.rejects.toMatchObject({ code: 'image-required' });
		expect(test.getItem().state).toBe('READY_FOR_REVIEW');
		await test.service.publish(identity, 'batch-1', 'intake-1', 'PUBLISH');
		expect(test.getItem().state).toBe('PUBLISHED');
	});

	it.each([
		['IMAGE_NOT_APPROVED', 'image-not-approved'],
		['STORY_NOT_APPROVED', 'story-not-approved'],
	] as const)('returns actionable %s publication validation', async (readiness, code) => {
		const test = setup(workflowItem('READY_FOR_REVIEW'));
		vi.mocked(test.repository.findPublicationReadiness).mockResolvedValueOnce(readiness);
		await expect(test.service.publish(identity, 'batch-1', 'intake-1', 'PUBLISH')).rejects.toMatchObject({ code });
		expect(test.repository.publishFinal).not.toHaveBeenCalled();
	});

	it('editing and image regeneration leave the article in final review', async () => {
		const test = setup(workflowItem('READY_FOR_REVIEW'));
		await test.service.recordEdit(identity, 'batch-1', 'intake-1', 'story-1');
		await test.service.regenerateImage(identity, 'batch-1', 'intake-1');
		expect(test.getItem().state).toBe('READY_FOR_REVIEW');
		expect(test.images.regenerate).toHaveBeenCalledWith('story-1', identity);
		expect(test.events).toEqual(['ARTICLE_EDITED', 'IMAGE_REGENERATED']);
	});

	it('fails closed before manual image regeneration when the image gate is disabled or the target differs', async () => {
		const test = setup(workflowItem('READY_FOR_REVIEW'));
		const disabled = new EditorialWorkflowService(test.repository, test.pipeline, test.images, {
			now: () => now, createId: () => 'disabled-image', generationEnabled: true,
			smokeTarget: { batchId: 'batch-1', intakeId: 'intake-1' }, imageGenerationEnabled: false,
		});
		await expect(disabled.regenerateImage(identity, 'batch-1', 'intake-1')).rejects.toThrow(/disabled/i);
		expect(test.images.regenerate).not.toHaveBeenCalled();

		const wrongTarget = new EditorialWorkflowService(test.repository, test.pipeline, test.images, {
			now: () => now, createId: () => 'wrong-target', generationEnabled: true,
			smokeTarget: { batchId: 'batch-other', intakeId: 'intake-other' }, imageGenerationEnabled: true,
		});
		await expect(wrongTarget.regenerateImage(identity, 'batch-1', 'intake-1')).rejects.toThrow(/outside the configured smoke target/i);
		expect(test.images.regenerate).not.toHaveBeenCalled();
	});

	it('rejecting a completed article is terminal but retains its item history', async () => {
		const test = setup(workflowItem('READY_FOR_REVIEW'));
		await test.service.reject(identity, 'batch-1', 'intake-1', 'REJECT');
		expect(test.getItem()).toMatchObject({ intakeId: 'intake-1', storyId: 'story-1', state: 'REJECTED' });
	});

	it('preserves a failed stage and retries without restarting terminal work', async () => {
		const test = setup(workflowItem('SELECTED'));
		vi.mocked(test.pipeline.advance).mockRejectedValueOnce(new Error('provider down'));
		await test.service.process(); expect(test.getItem().state).toBe('FAILED');
		await test.service.retry(identity, 'batch-1', 'intake-1'); expect(test.getItem().state).toBe('SELECTED');
	});

	it('renders source, article, image, batch progress, and typing-safe shortcuts together', () => {
		const page = readFileSync(join(process.cwd(), 'src/pages/editorial/batches/[id]/review.astro'), 'utf8');
		expect(page).toContain('Source context'); expect(page).toContain('Article body'); expect(page).toContain('/editorial/media/');
		expect(page).toContain('Article {index + 1} of {packages.length}');
		expect(page).toContain("target.matches('input, textarea, select')");
		expect(page).toContain("key === 'arrowleft'"); expect(page).toContain('data-shortcut="p"');
	});

	it('keeps legacy candidate and story routes available', () => {
		expect(readFileSync(join(process.cwd(), 'src/pages/editorial/candidates/[id].astro'), 'utf8')).toContain('Candidate provenance');
		expect(readFileSync(join(process.cwd(), 'src/pages/editorial/stories/[id].astro'), 'utf8')).toContain('Audit history');
	});

	it('surfaces known publication prerequisites while retaining a generic unexpected-failure message', () => {
		const actions = readFileSync(join(process.cwd(), 'src/lib/editorial-actions.ts'), 'utf8');
		const messages = readFileSync(join(process.cwd(), 'src/components/EditorialMessage.astro'), 'utf8');
		for (const code of ['image-required', 'image-not-approved', 'story-not-approved']) {
			expect(actions).toContain(`'${code}'`);
			expect(messages).toContain(`'${code}'`);
		}
		expect(actions).toContain("redirectWithResult(returnPath, 'error', 'operation-failed')");
		expect(messages).toContain("'operation-failed': 'The editorial operation could not be completed.'");
	});

	it('requires an audited candidate selection before automatic body generation and disables model-level retries', () => {
		const runtime = readFileSync(join(process.cwd(), 'src/services/runtime-editorial-workflow.ts'), 'utf8');
		expect(runtime).toContain("throw new Error('NORMALIZATION_REVIEW_REQUIRED')");
		expect(runtime).toContain("throw new Error('CANDIDATE_SELECTION_REQUIRED')");
		expect(runtime).not.toContain('generation.generateCandidates');
		expect(runtime).toContain('workflow:body:v2:${item.batchId}:${item.intakeId}:attempt:${item.retryAttempt}');
		expect(runtime).toContain('maxAttempts: 1');
	});
});
