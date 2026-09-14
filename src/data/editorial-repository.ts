import type {
	AuditEntry,
	CandidateStatus,
	EditorialArchiveCounts,
	EditorialDashboardCounts,
	EditorialStory,
	SatireCandidate,
	SatireSuitability,
	SourceIntake,
	SourceTier,
	SourceType,
} from '../domain/editorial';
import type { NonPublishingStatus } from '../domain/publication-status';
import type { StoryCategory } from '../domain/story';

export interface CreateIntakeRecord {
	intakeId: string;
	referenceId: string;
	title: string;
	neutralBrief: string;
	significanceScore: number;
	satirePotentialScore: number;
	satireSuitability: SatireSuitability;
	editorialNotes: string;
	sourceTitle: string;
	sourceUrl: string;
	publisherName: string;
	sourceTier: SourceTier;
	sourceType: SourceType;
	publishedAt: string | null;
	actorEmail: string;
	createdAt: string;
	auditIds: [string, string];
}

export interface UpdateIntakeRecord {
	id: string;
	title: string;
	neutralBrief: string;
	significanceScore: number;
	satirePotentialScore: number;
	satireSuitability: SatireSuitability;
	editorialNotes: string;
	actorEmail: string;
	updatedAt: string;
	auditId: string;
}

export interface AddSourceReferenceRecord {
	id: string;
	sourceIntakeId: string;
	sourceTitle: string;
	sourceUrl: string;
	publisherName: string;
	sourceTier: SourceTier;
	sourceType: SourceType;
	publishedAt: string | null;
	actorEmail: string;
	createdAt: string;
	auditId: string;
}

export interface UpdateSourceReferenceRecord {
	id: string;
	sourceTitle: string;
	sourceUrl: string;
	publisherName: string;
	sourceTier: SourceTier;
	sourceType: SourceType;
	publishedAt: string | null;
	actorEmail: string;
	updatedAt: string;
	auditId: string;
}

export interface CreateCandidateRecord {
	id: string;
	sourceIntakeId: string;
	proposedHeadline: string;
	proposedDeck: string;
	draftBodyMarkdown: string;
	categoryId: string;
	editorialNotes: string;
	actorEmail: string;
	createdAt: string;
	auditId: string;
}

export interface UpdateCandidateRecord {
	id: string;
	proposedHeadline: string;
	proposedDeck: string;
	draftBodyMarkdown: string;
	categoryId: string;
	editorialNotes: string;
	actorEmail: string;
	updatedAt: string;
	auditId: string;
}

export interface TransitionCandidateRecord {
	id: string;
	from: CandidateStatus;
	to: CandidateStatus;
	actorEmail: string;
	updatedAt: string;
	auditId: string;
}

export interface ArchiveRecord {
	id: string;
	actorEmail: string;
	archivedAt: string;
	reason: string | null;
	auditId: string;
}

export interface RestoreRecord {
	id: string;
	actorEmail: string;
	restoredAt: string;
	reason: string | null;
	auditId: string;
}

export interface BulkArchiveRecord {
	actorEmail: string;
	archivedAt: string;
	reason: string | null;
	auditIdPrefix: string;
	expectedCount: number;
}

export interface ConvertCandidateRecord {
	candidateId: string;
	storyId: string;
	slug: string;
	editionDate: string;
	socialExcerpt: string;
	actorEmail: string;
	createdAt: string;
	auditIds: [string, string];
}

export interface UpdateStoryRecord {
	id: string;
	slug: string;
	headline: string;
	deck: string;
	bodyMarkdown: string;
	editionDate: string;
	categoryId: string;
	socialExcerpt: string;
	tags: string[];
	actorEmail: string;
	updatedAt: string;
	auditId: string;
}

export interface TransitionStoryRecord {
	id: string;
	from: NonPublishingStatus | 'PUBLISHED';
	to: NonPublishingStatus;
	actorEmail: string;
	updatedAt: string;
	auditId: string;
}

export interface PublishApprovedStoryRecord {
	id: string;
	actorEmail: string;
	publishedAt: string;
	auditId: string;
}

export interface EditorialRepository {
	getDashboardCounts(): Promise<EditorialDashboardCounts>;
	getArchiveCounts(): Promise<EditorialArchiveCounts>;
	listCategories(): Promise<StoryCategory[]>;
	categoryExists(id: string): Promise<boolean>;
	listIntakes(limit?: number): Promise<SourceIntake[]>;
	listArchivedIntakes(limit?: number): Promise<SourceIntake[]>;
	findIntakeById(id: string): Promise<SourceIntake | null>;
	createIntake(record: CreateIntakeRecord): Promise<void>;
	updateIntake(record: UpdateIntakeRecord): Promise<boolean>;
	archiveUnsuitableIntake(record: ArchiveRecord): Promise<boolean>;
	restoreIntake(record: RestoreRecord): Promise<boolean>;
	archiveAllUnsuitableIntakes(record: BulkArchiveRecord): Promise<number>;
	addSourceReference(record: AddSourceReferenceRecord): Promise<boolean>;
	updateSourceReference(record: UpdateSourceReferenceRecord): Promise<boolean>;
	listCandidates(limit?: number): Promise<SatireCandidate[]>;
	listArchivedCandidates(limit?: number): Promise<SatireCandidate[]>;
	findCandidateById(id: string): Promise<SatireCandidate | null>;
	createCandidate(record: CreateCandidateRecord): Promise<boolean>;
	updateCandidate(record: UpdateCandidateRecord): Promise<boolean>;
	transitionCandidate(record: TransitionCandidateRecord): Promise<boolean>;
	archiveRejectedCandidate(record: ArchiveRecord): Promise<boolean>;
	restoreCandidate(record: RestoreRecord): Promise<boolean>;
	archiveAllRejectedCandidates(record: BulkArchiveRecord): Promise<number>;
	convertApprovedCandidateToDraft(record: ConvertCandidateRecord): Promise<boolean>;
	listEditorialStories(limit?: number): Promise<EditorialStory[]>;
	findEditorialStoryById(id: string): Promise<EditorialStory | null>;
	updateStory(record: UpdateStoryRecord): Promise<boolean>;
	transitionStory(record: TransitionStoryRecord): Promise<boolean>;
	publishApprovedStory(record: PublishApprovedStoryRecord): Promise<boolean>;
	listAuditEntries(
		entityType: AuditEntry['entityType'],
		entityId: string,
	): Promise<AuditEntry[]>;
}
