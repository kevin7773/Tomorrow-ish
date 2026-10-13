import type { EditorialBatch, EditorialBatchItem } from '../domain/editorial-workflow';
import type { PublicationReadiness } from '../domain/publication-integrity';

export interface CandidateSelection {
	batchId: string;
	intakeId: string;
	normalizedEventVersionId: string;
	candidateId: string;
	selectedByEmail: string;
	selectedAt: string;
	revision: number;
}

export interface CandidateSelectionContext {
	batchId: string;
	intakeId: string;
	normalizedEventVersionId: string;
	selectedCandidateId: string | null;
	selectedByEmail: string | null;
	selectedAt: string | null;
}

export interface EditorialWorkflowRepository {
	listBatches(limit?: number): Promise<EditorialBatch[]>;
	findBatch(id: string): Promise<EditorialBatch | null>;
	findItem(batchId: string, intakeId: string): Promise<EditorialBatchItem | null>;
	findCandidateSelection(batchId: string, intakeId: string): Promise<CandidateSelection | null>;
	isAcceptedNormalization(versionId: string, intakeId: string): Promise<boolean>;
	findCandidateSelectionContext(candidateId: string): Promise<CandidateSelectionContext | null>;
	selectCandidate(record: { id: string; batchId: string; intakeId: string; normalizedEventVersionId: string; candidateId: string; actorEmail: string; at: string; reason: string | null; leaseOwner?: string }): Promise<CandidateSelection | null>;
	claimProcessable(record: { limit: number; owner: string; at: string; leaseExpiresAt: string; createEventId: () => string; target?: { batchId: string; intakeId: string }; routineOnly?: boolean }): Promise<EditorialBatchItem[]>;
	renewLease?(batchId: string, intakeId: string, owner: string, at: string, leaseExpiresAt: string): Promise<boolean>;
	reconcilePublished(record: { limit: number; actorEmail: string; at: string; createEventId: () => string; createAuditId: () => string }): Promise<number>;
	select(batchId: string, intakeId: string, actorEmail: string, at: string, eventId: string): Promise<boolean>;
	rejectIntake(batchId: string, intakeId: string, actorEmail: string, at: string, eventId: string): Promise<boolean>;
	attachCandidate(batchId: string, intakeId: string, candidateId: string, owner: string, at: string): Promise<boolean>;
	findGeneratedCandidateId(intakeId: string, modelRunId: string): Promise<string | null>;
	findStoryIdByCandidate(candidateId: string): Promise<string | null>;
	attachExistingStory(record: { batchId: string; intakeId: string; candidateId: string; storyId: string; owner: string; at: string; eventId: string }): Promise<boolean>;
	ensureReviewStory(record: {
		batchId: string; intakeId: string; candidateId: string; storyId: string; slug: string;
		editionDate: string; socialExcerpt: string; actorEmail: string; owner: string; at: string; eventId: string;
	}): Promise<string | null>;
	markReady(batchId: string, intakeId: string, storyId: string, owner: string, at: string, eventId: string, allowMissingImage?: boolean): Promise<boolean>;
	markFailed(batchId: string, intakeId: string, owner: string, stage: string, classification: string, at: string, eventId: string): Promise<void>;
	releaseLease(batchId: string, intakeId: string, owner: string, at: string): Promise<boolean>;
	retryFailed(batchId: string, intakeId: string, actorEmail: string, at: string, eventId: string): Promise<boolean>;
	ensureFinalReminder(batchId: string, at: string, eventId: string): Promise<boolean>;
	findPublicationReadiness(storyId: string): Promise<PublicationReadiness>;
	publishFinal(record: { batchId: string; intakeId: string; storyId: string; actorEmail: string; at: string; eventId: string; auditId: string }): Promise<boolean>;
	rejectFinal(record: { batchId: string; intakeId: string; storyId: string; actorEmail: string; at: string; eventId: string; auditId: string }): Promise<boolean>;
	recordEvent(record: { id: string; batchId: string; intakeId: string; storyId: string | null; kind: string; detail?: string | null; at: string }): Promise<void>;
}
