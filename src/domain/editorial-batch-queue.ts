import type { EditorialBatch } from './editorial-workflow';

export type EditorialBatchQueueAction =
	| { kind: 'link'; label: 'Triage' | 'Final review' | 'Review failure'; href: string; quiet: boolean }
	| { kind: 'status'; label: 'Generating…' }
	| null;

export interface EditorialBatchQueueEntry {
	batch: EditorialBatch;
	awaitingTriage: number;
	generating: number;
	readyForFinalReview: number;
	failed: number;
	active: boolean;
	action: EditorialBatchQueueAction;
}

export function summarizeEditorialBatch(batch: EditorialBatch): EditorialBatchQueueEntry {
	const awaitingTriage = batch.items.filter((item) => item.state === 'INGESTED').length;
	const generating = batch.items.filter((item) => item.state === 'SELECTED' || item.state === 'GENERATING').length;
	const readyForFinalReview = batch.items.filter((item) => item.state === 'READY_FOR_REVIEW').length;
	const failed = batch.items.filter((item) => item.state === 'FAILED').length;
	const active = awaitingTriage > 0 || generating > 0 || readyForFinalReview > 0 || failed > 0;
	let action: EditorialBatchQueueAction = null;
	if (awaitingTriage > 0) {
		action = { kind: 'link', label: 'Triage', href: `/editorial/batches/${batch.id}/triage`, quiet: false };
	} else if (generating > 0) {
		action = { kind: 'status', label: 'Generating…' };
	} else if (readyForFinalReview > 0) {
		action = { kind: 'link', label: 'Final review', href: `/editorial/batches/${batch.id}/review`, quiet: false };
	} else if (failed > 0) {
		action = { kind: 'link', label: 'Review failure', href: `/editorial/batches/${batch.id}/review`, quiet: true };
	}
	return { batch, awaitingTriage, generating, readyForFinalReview, failed, active, action };
}
