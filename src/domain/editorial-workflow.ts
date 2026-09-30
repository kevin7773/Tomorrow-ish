export const EDITORIAL_WORKFLOW_STATES = [
	'INGESTED', 'SELECTED', 'GENERATING', 'READY_FOR_REVIEW', 'PUBLISHED', 'REJECTED', 'FAILED',
] as const;

export type EditorialWorkflowState = (typeof EDITORIAL_WORKFLOW_STATES)[number];

export interface EditorialBatchItem {
	batchId: string;
	intakeId: string;
	ordinal: number;
	categoryId: string;
	state: EditorialWorkflowState;
	selectedByEmail: string | null;
	selectedAt: string | null;
	candidateId: string | null;
	storyId: string | null;
	failureStage: string | null;
	failureClassification: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface EditorialBatch {
	id: string;
	itemCount: number;
	createdAt: string;
	triageCompletedAt: string | null;
	finalReviewCompletedAt: string | null;
	items: EditorialBatchItem[];
}
