import type { EditorialBatch } from './editorial-workflow';

export type EditorialBatchQueueAction =
	| { kind: 'link'; label: string; href: string; quiet: boolean }
	| { kind: 'status'; label: 'Generating…' | 'Queued' }
	| null;

export interface EditorialBatchQueueEntry {
	batch: EditorialBatch;
	awaitingTriage: number;
	queued: number;
	generating: number;
	readyForFinalReview: number;
	failed: number;
	active: boolean;
	action: EditorialBatchQueueAction;
}

export function summarizeEditorialBatch(batch: EditorialBatch, now = new Date().toISOString()): EditorialBatchQueueEntry {
	const awaitingTriage = batch.items.filter((item) => item.state === 'INGESTED').length;
	const activeGeneration = (item: EditorialBatch['items'][number]) => item.state === 'GENERATING'
		&& Boolean(item.leaseOwner && item.leaseAcquiredAt && item.leaseExpiresAt && item.leaseExpiresAt > now);
	const generating = batch.items.filter(activeGeneration).length;
	const queued = batch.items.filter((item) => item.state === 'SELECTED'
		|| (item.state === 'GENERATING' && !activeGeneration(item))).length;
	const readyForFinalReview = batch.items.filter((item) => item.state === 'READY_FOR_REVIEW').length;
	const failed = batch.items.filter((item) => item.state === 'FAILED').length;
	const active = awaitingTriage > 0 || queued > 0 || generating > 0 || readyForFinalReview > 0 || failed > 0;
	let action: EditorialBatchQueueAction = null;
	if (awaitingTriage > 0) {
		action = { kind: 'link', label: 'Triage', href: `/editorial/batches/${batch.id}/triage`, quiet: false };
	} else if (generating > 0) {
		action = { kind: 'status', label: 'Generating…' };
	} else if (readyForFinalReview > 0) {
		action = { kind: 'link', label: failed > 0 ? `Final review · ${failed} failed` : 'Final review', href: `/editorial/batches/${batch.id}/review`, quiet: false };
	} else if (failed > 0) {
		action = { kind: 'link', label: 'Review failure', href: `/editorial/batches/${batch.id}/review`, quiet: true };
	} else if (queued > 0) {
		action = { kind: 'status', label: 'Queued' };
	}
	return { batch, awaitingTriage, queued, generating, readyForFinalReview, failed, active, action };
}
