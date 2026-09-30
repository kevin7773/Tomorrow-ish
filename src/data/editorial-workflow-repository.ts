import type { EditorialBatch, EditorialBatchItem } from '../domain/editorial-workflow';

export interface EditorialWorkflowRepository {
	listBatches(limit?: number): Promise<EditorialBatch[]>;
	findBatch(id: string): Promise<EditorialBatch | null>;
	findItem(batchId: string, intakeId: string): Promise<EditorialBatchItem | null>;
	listProcessable(limit: number): Promise<EditorialBatchItem[]>;
	select(batchId: string, intakeId: string, actorEmail: string, at: string, eventId: string): Promise<boolean>;
	rejectIntake(batchId: string, intakeId: string, actorEmail: string, at: string, eventId: string): Promise<boolean>;
	markGenerating(batchId: string, intakeId: string, at: string, eventId: string): Promise<boolean>;
	attachCandidate(batchId: string, intakeId: string, candidateId: string, at: string): Promise<boolean>;
	findGeneratedCandidateId(intakeId: string, modelRunId: string): Promise<string | null>;
	createReviewStory(record: {
		batchId: string; intakeId: string; candidateId: string; storyId: string; slug: string;
		editionDate: string; socialExcerpt: string; actorEmail: string; at: string; eventId: string;
	}): Promise<boolean>;
	markReady(batchId: string, intakeId: string, storyId: string, at: string, eventId: string): Promise<boolean>;
	markFailed(batchId: string, intakeId: string, stage: string, classification: string, at: string, eventId: string): Promise<void>;
	retryFailed(batchId: string, intakeId: string, actorEmail: string, at: string, eventId: string): Promise<boolean>;
	ensureFinalReminder(batchId: string, at: string, eventId: string): Promise<boolean>;
	publishFinal(record: { batchId: string; intakeId: string; storyId: string; actorEmail: string; at: string; eventId: string; auditId: string }): Promise<boolean>;
	rejectFinal(record: { batchId: string; intakeId: string; storyId: string; actorEmail: string; at: string; eventId: string; auditId: string }): Promise<boolean>;
	recordEvent(record: { id: string; batchId: string; intakeId: string; storyId: string | null; kind: string; detail?: string | null; at: string }): Promise<void>;
}
