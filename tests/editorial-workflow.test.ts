import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EditorialWorkflowRepository } from '../src/data/editorial-workflow-repository';
import type { EditorialBatchItem } from '../src/domain/editorial-workflow';
import { EditorialWorkflowService, type FinalReviewImagePort, type WorkflowPipelinePort } from '../src/services/editorial-workflow-service';

const identity = { email: 'Editor@Tomorrow-ish.news' };
const now = '2026-09-27T12:00:00.000Z';

function workflowItem(state: EditorialBatchItem['state'] = 'INGESTED'): EditorialBatchItem {
	return { batchId: 'batch-1', intakeId: 'intake-1', ordinal: 1, categoryId: 'cat-civic-life', state,
		selectedByEmail: state === 'INGESTED' ? null : identity.email.toLowerCase(), selectedAt: state === 'INGESTED' ? null : now,
		candidateId: state === 'GENERATING' ? 'candidate-1' : null,
		storyId: state === 'READY_FOR_REVIEW' ? 'story-1' : null,
		failureStage: state === 'FAILED' ? 'IMAGE' : null, failureClassification: state === 'FAILED' ? 'PROVIDER' : null,
		createdAt: now, updatedAt: now };
}

function setup(initial = workflowItem()) {
	let item = initial;
	const events: string[] = [];
	const repository: EditorialWorkflowRepository = {
		listBatches: vi.fn(), findBatch: vi.fn(), findItem: vi.fn(async () => ({ ...item })),
		listProcessable: vi.fn(async () => ['SELECTED', 'GENERATING'].includes(item.state) ? [{ ...item }] : []),
		select: vi.fn(async () => { if (item.state !== 'INGESTED') return false; item = { ...item, state: 'SELECTED', selectedByEmail: identity.email.toLowerCase(), selectedAt: now }; events.push('INTAKE_SELECTED'); return true; }),
		rejectIntake: vi.fn(async () => { if (item.state !== 'INGESTED') return false; item = { ...item, state: 'REJECTED' }; events.push('INTAKE_REJECTED'); return true; }),
		markGenerating: vi.fn(async () => { if (item.state !== 'SELECTED') return false; item = { ...item, state: 'GENERATING' }; events.push('GENERATION_STARTED'); return true; }),
		attachCandidate: vi.fn(), findGeneratedCandidateId: vi.fn(), createReviewStory: vi.fn(),
		markReady: vi.fn(async (_batch, _intake, storyId) => { item = { ...item, state: 'READY_FOR_REVIEW', storyId }; events.push('ARTICLE_READY_FOR_REVIEW'); return true; }),
		markFailed: vi.fn(async () => { item = { ...item, state: 'FAILED', failureStage: 'AUTOMATIC_GENERATION', failureClassification: 'PIPELINE_FAILURE' }; events.push('GENERATION_FAILED'); }),
		retryFailed: vi.fn(async () => { if (item.state !== 'FAILED') return false; item = { ...item, state: 'SELECTED', failureStage: null, failureClassification: null }; return true; }),
		ensureFinalReminder: vi.fn(async () => item.state === 'READY_FOR_REVIEW'),
		publishFinal: vi.fn(async () => { if (item.state !== 'READY_FOR_REVIEW') return false; item = { ...item, state: 'PUBLISHED' }; events.push('ARTICLE_PUBLISHED'); return true; }),
		rejectFinal: vi.fn(async () => { if (item.state !== 'READY_FOR_REVIEW') return false; item = { ...item, state: 'REJECTED' }; events.push('ARTICLE_REJECTED'); return true; }),
		recordEvent: vi.fn(async ({ kind }) => { events.push(kind); }),
	};
	const pipeline: WorkflowPipelinePort = { advance: vi.fn(async () => ({ storyId: 'story-1', ready: true })) };
	const images: FinalReviewImagePort = { approveLatestGenerated: vi.fn(async () => undefined), regenerate: vi.fn(async () => undefined) };
	let id = 0;
	const service = new EditorialWorkflowService(repository, pipeline, images, { now: () => now, createId: () => `id-${++id}` });
	return { service, repository, pipeline, images, events, getItem: () => item };
}

describe('two-gate editorial workflow', () => {
	it('demonstrates a complete three-item session with no hidden intermediate human gate', async () => {
		const items = new Map(['intake-1', 'intake-2', 'intake-3'].map((intakeId, index) => [intakeId, {
			...workflowItem(), intakeId, ordinal: index + 1,
		}]));
		const events: string[] = [];
		const repository: EditorialWorkflowRepository = {
			listBatches: vi.fn(), findBatch: vi.fn(),
			findItem: vi.fn(async (_batchId, intakeId) => ({ ...items.get(intakeId)! })),
			listProcessable: vi.fn(async () => [...items.values()].filter((item) => ['SELECTED', 'GENERATING'].includes(item.state)).map((item) => ({ ...item }))),
			select: vi.fn(async (_batchId, intakeId) => { const item = items.get(intakeId)!; if (item.state !== 'INGESTED') return false; items.set(intakeId, { ...item, state: 'SELECTED', selectedByEmail: identity.email.toLowerCase(), selectedAt: now }); events.push('INTAKE_SELECTED'); return true; }),
			rejectIntake: vi.fn(async (_batchId, intakeId) => { const item = items.get(intakeId)!; if (item.state !== 'INGESTED') return false; items.set(intakeId, { ...item, state: 'REJECTED' }); events.push('INTAKE_REJECTED'); return true; }),
			markGenerating: vi.fn(async (_batchId, intakeId) => { const item = items.get(intakeId)!; if (item.state !== 'SELECTED') return false; items.set(intakeId, { ...item, state: 'GENERATING' }); events.push('GENERATION_STARTED'); return true; }),
			attachCandidate: vi.fn(), findGeneratedCandidateId: vi.fn(), createReviewStory: vi.fn(),
			markReady: vi.fn(async (_batchId, intakeId, storyId) => { const item = items.get(intakeId)!; items.set(intakeId, { ...item, state: 'READY_FOR_REVIEW', storyId }); events.push('ARTICLE_READY_FOR_REVIEW'); return true; }),
			markFailed: vi.fn(), retryFailed: vi.fn(), ensureFinalReminder: vi.fn(async () => true),
			publishFinal: vi.fn(async ({ intakeId }) => { const item = items.get(intakeId)!; items.set(intakeId, { ...item, state: 'PUBLISHED' }); events.push('ARTICLE_PUBLISHED'); return true; }),
			rejectFinal: vi.fn(async ({ intakeId }) => { const item = items.get(intakeId)!; items.set(intakeId, { ...item, state: 'REJECTED' }); events.push('ARTICLE_REJECTED'); return true; }),
			recordEvent: vi.fn(async ({ kind }) => { events.push(kind); }),
		};
		const pipeline: WorkflowPipelinePort = { advance: vi.fn(async (item) => ({ storyId: `story-${item.intakeId.at(-1)}`, ready: true })) };
		const images: FinalReviewImagePort = { approveLatestGenerated: vi.fn(async () => undefined), regenerate: vi.fn(async () => undefined) };
		let id = 0;
		const service = new EditorialWorkflowService(repository, pipeline, images, { now: () => now, createId: () => `demo-${++id}` });

		await service.triage(identity, 'batch-1', ['intake-1', 'intake-2'], 'SELECT');
		await service.triage(identity, 'batch-1', ['intake-3'], 'REJECT');
		expect(await service.process()).toEqual({ ready: 2, pending: 0, failed: 0 });
		expect(pipeline.advance).toHaveBeenCalledTimes(2);
		expect([...items.values()].map((item) => item.state)).toEqual(['READY_FOR_REVIEW', 'READY_FOR_REVIEW', 'REJECTED']);

		await service.recordEdit(identity, 'batch-1', 'intake-1', 'story-1');
		await service.regenerateImage(identity, 'batch-1', 'intake-2');
		await service.publish(identity, 'batch-1', 'intake-1', 'PUBLISH');
		await service.reject(identity, 'batch-1', 'intake-2', 'REJECT');
		expect([...items.values()].map((item) => item.state)).toEqual(['PUBLISHED', 'REJECTED', 'REJECTED']);
		expect([...items.values()].filter((item) => item.state === 'READY_FOR_REVIEW')).toHaveLength(0);
		expect(events).toContain('ARTICLE_EDITED');
		expect(events).toContain('IMAGE_REGENERATED');
	});

	it('rejecting at Gate 1 prevents generation', async () => {
		const test = setup(); await test.service.triage(identity, 'batch-1', ['intake-1'], 'REJECT'); await test.service.process();
		expect(test.getItem().state).toBe('REJECTED'); expect(test.pipeline.advance).not.toHaveBeenCalled();
	});

	it('selection automatically progresses through generation to final review without another human gate', async () => {
		const test = setup(); await test.service.triage(identity, 'batch-1', ['intake-1'], 'SELECT');
		expect(await test.service.process()).toMatchObject({ ready: 1, failed: 0 });
		expect(test.events).toEqual(['INTAKE_SELECTED', 'GENERATION_STARTED', 'ARTICLE_READY_FOR_REVIEW']);
		expect(test.repository.ensureFinalReminder).toHaveBeenCalledWith('batch-1', now, expect.any(String));
	});

	it('requires explicit publication and blocks incomplete final packages', async () => {
		const test = setup(workflowItem('READY_FOR_REVIEW'));
		await expect(test.service.publish(identity, 'batch-1', 'intake-1', '')).rejects.toThrow(/PUBLISH/);
		expect(test.repository.publishFinal).not.toHaveBeenCalled();
		vi.mocked(test.images.approveLatestGenerated).mockRejectedValueOnce(new Error('image missing'));
		await expect(test.service.publish(identity, 'batch-1', 'intake-1', 'PUBLISH')).rejects.toThrow('image missing');
		expect(test.getItem().state).toBe('READY_FOR_REVIEW');
		await test.service.publish(identity, 'batch-1', 'intake-1', 'PUBLISH');
		expect(test.getItem().state).toBe('PUBLISHED');
	});

	it('editing and image regeneration leave the article in final review', async () => {
		const test = setup(workflowItem('READY_FOR_REVIEW'));
		await test.service.recordEdit(identity, 'batch-1', 'intake-1', 'story-1');
		await test.service.regenerateImage(identity, 'batch-1', 'intake-1');
		expect(test.getItem().state).toBe('READY_FOR_REVIEW');
		expect(test.images.regenerate).toHaveBeenCalledWith('story-1', identity);
		expect(test.events).toEqual(['ARTICLE_EDITED', 'IMAGE_REGENERATED']);
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
});
