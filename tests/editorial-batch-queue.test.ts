import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarizeEditorialBatch } from '../src/domain/editorial-batch-queue';
import type { EditorialBatch, EditorialBatchItem, EditorialWorkflowState } from '../src/domain/editorial-workflow';

const NOW = '2026-09-30T12:00:00.000Z';

function batch(id: string, states: EditorialWorkflowState[]): EditorialBatch {
	const items: EditorialBatchItem[] = states.map((state, index) => ({
		batchId: id, intakeId: `${id}-intake-${index + 1}`, ordinal: index + 1,
		categoryId: 'cat-civic-life', state, selectedByEmail: state === 'INGESTED' ? null : 'editor@example.test',
		selectedAt: state === 'INGESTED' ? null : NOW, candidateId: null, storyId: null,
		failureStage: state === 'FAILED' ? 'AUTOMATIC_GENERATION' : null,
		failureClassification: state === 'FAILED' ? 'PROVIDER' : null,
		leaseOwner: null, leaseAcquiredAt: null, leaseExpiresAt: null, attemptCount: 0, retryAttempt: 0,
		createdAt: NOW, updatedAt: NOW,
	}));
	return { id, itemCount: items.length, createdAt: NOW, triageCompletedAt: null, finalReviewCompletedAt: null, items };
}

describe('editorial batch active queue', () => {
	it('maps awaiting triage to the correct primary action', () => {
		const entry = summarizeEditorialBatch(batch('batch-triage', ['INGESTED', 'SELECTED']));
		expect(entry.active).toBe(true);
		expect(entry.action).toEqual({ kind: 'link', label: 'Triage', href: '/editorial/batches/batch-triage/triage', quiet: false });
	});

	it('shows generating progress without an actionable final-review link', () => {
		const active = batch('batch-generating', ['GENERATING', 'SELECTED', 'REJECTED']);
		active.items[0] = { ...active.items[0], leaseOwner: 'worker', leaseAcquiredAt: NOW, leaseExpiresAt: '2026-09-30T12:10:00.000Z' };
		const entry = summarizeEditorialBatch(active, NOW);
		expect(entry).toMatchObject({ active: true, generating: 1, queued: 1, readyForFinalReview: 0, action: { kind: 'status', label: 'Generating…' } });
		expect(entry.action).not.toHaveProperty('href');
	});

	it('labels selected and unleased generating rows as queued rather than active generation', () => {
		const entry = summarizeEditorialBatch(batch('batch-queued', ['SELECTED', 'GENERATING']), NOW);
		expect(entry).toMatchObject({ active: true, generating: 0, queued: 2, action: { kind: 'status', label: 'Queued' } });
	});

	it('maps ready work to the correct final-review route', () => {
		const entry = summarizeEditorialBatch(batch('batch-ready', ['READY_FOR_REVIEW', 'REJECTED']));
		expect(entry.action).toEqual({ kind: 'link', label: 'Final review', href: '/editorial/batches/batch-ready/review', quiet: false });
	});

	it('exposes mixed final-review and failure work in the primary action', () => {
		const entry = summarizeEditorialBatch(batch('batch-mixed', ['READY_FOR_REVIEW', 'FAILED']), NOW);
		expect(entry).toMatchObject({ readyForFinalReview: 1, failed: 1,
			action: { kind: 'link', label: 'Final review · 1 failed', href: '/editorial/batches/batch-mixed/review' } });
	});

	it('omits terminal and retired smoke-test batches without matching their names', () => {
		const terminal = summarizeEditorialBatch(batch('legitimate-complete-batch', ['PUBLISHED', 'REJECTED']));
		const retiredFixture = summarizeEditorialBatch(batch('notification-smoke-any-name', ['REJECTED']));
		expect(terminal).toMatchObject({ active: false, action: null });
		expect(retiredFixture).toMatchObject({ active: false, action: null });
	});

	it('keeps legitimate active production batches visible and does not mutate them', () => {
		const production = batch('73690f2f-9282-4f23-9d65-2bf2945323b5', ['GENERATING', 'GENERATING', 'REJECTED']);
		production.items[0] = { ...production.items[0], leaseOwner: 'worker-1', leaseAcquiredAt: NOW, leaseExpiresAt: '2026-09-30T12:10:00.000Z' };
		production.items[1] = { ...production.items[1], leaseOwner: 'worker-2', leaseAcquiredAt: NOW, leaseExpiresAt: '2026-09-30T12:10:00.000Z' };
		const before = structuredClone(production);
		expect(summarizeEditorialBatch(production, NOW)).toMatchObject({ active: true, generating: 2, queued: 0 });
		expect(production).toEqual(before);
	});

	it('queries only durable active workflow states without fixture-name special cases or writes', () => {
		const source = readFileSync(join(process.cwd(), 'src/data/d1-editorial-workflow-repository.ts'), 'utf8');
		const query = source.slice(source.indexOf('async listBatches'), source.indexOf('async findBatch'));
		expect(query).toContain("'INGESTED', 'SELECTED', 'GENERATING', 'READY_FOR_REVIEW', 'FAILED'");
		expect(query).not.toContain('notification-smoke');
		expect(query).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
	});
});
