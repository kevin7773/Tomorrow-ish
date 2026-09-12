import type { PublicationStatus } from './publication-status';
import type { StoryCategory } from './story';
import type { GuardrailFlag } from './generation';

export const SOURCE_TIERS = ['TIER_1', 'TIER_2', 'CONTEXT_ONLY'] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

export const SOURCE_TYPES = [
	'PRIMARY',
	'WIRE',
	'STRAIGHT_NEWS',
	'LOCAL_NEWS',
	'TRADE',
	'PRESS_RELEASE',
	'SOCIAL_CONTEXT',
	'COMMUNITY_CONTEXT',
	'OTHER',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SATIRE_SUITABILITIES = [
	'UNREVIEWED',
	'SUITABLE',
	'SENSITIVE',
	'UNSUITABLE',
] as const;
export type SatireSuitability = (typeof SATIRE_SUITABILITIES)[number];

export const CANDIDATE_STATUSES = ['DRAFT', 'REVIEW', 'APPROVED', 'REJECTED'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export interface EditorialIdentity {
	email: string;
}

export interface SourceReference {
	id: string;
	sourceIntakeId: string;
	sourceTitle: string;
	sourceUrl: string;
	publisherName: string;
	sourceTier: SourceTier;
	sourceType: SourceType;
	publishedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface SourceIntake {
	id: string;
	title: string;
	neutralBrief: string;
	significanceScore: number;
	satirePotentialScore: number;
	satireSuitability: SatireSuitability;
	editorialNotes: string;
	suitabilityReason: string;
	guardrailFlags: GuardrailFlag[];
	assessmentReviewedByEmail: string | null;
	assessmentReviewedAt: string | null;
	acceptedModelRunId: string | null;
	createdByEmail: string;
	updatedByEmail: string;
	createdAt: string;
	updatedAt: string;
	references: SourceReference[];
}

export interface SatireCandidate {
	id: string;
	sourceIntakeId: string;
	sourceIntakeTitle: string;
	proposedHeadline: string;
	proposedDeck: string;
	draftBodyMarkdown: string;
	category: StoryCategory;
	editorialNotes: string;
	status: CandidateStatus;
	createdByEmail: string;
	updatedByEmail: string;
	createdAt: string;
	updatedAt: string;
	convertedStoryId: string | null;
	originModelRunId: string | null;
	normalizedEventVersionId: string | null;
	generationOrdinal: number | null;
	rationale: string;
	satiricalMechanism: string;
	originKind: 'MANUAL' | 'MODEL';
	bodyGenerationState: 'NOT_REQUESTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED';
	bodyGenerationRunId: string | null;
}

export interface EditorialStory {
	id: string;
	slug: string;
	headline: string;
	deck: string;
	bodyMarkdown: string;
	editionDate: string;
	publishedAt: string | null;
	category: StoryCategory;
	status: PublicationStatus;
	socialExcerpt: string;
	tags: string[];
	ogImageKey: string | null;
	originCandidateId: string | null;
	updatedAt: string;
}

export interface EditorialDashboardCounts {
	intakes: number;
	candidatesInReview: number;
	approvedCandidates: number;
	storiesAwaitingPublication: number;
}

export interface AuditEntry {
	id: string;
	actorEmail: string;
	entityType: 'SOURCE_INTAKE' | 'SOURCE_REFERENCE' | 'SATIRE_CANDIDATE' | 'STORY';
	entityId: string;
	action: string;
	fromStatus: string | null;
	toStatus: string | null;
	reason: string | null;
	createdAt: string;
}

export function isSourceTier(value: unknown): value is SourceTier {
	return typeof value === 'string' && SOURCE_TIERS.includes(value as SourceTier);
}

export function isSourceType(value: unknown): value is SourceType {
	return typeof value === 'string' && SOURCE_TYPES.includes(value as SourceType);
}

export function isSatireSuitability(value: unknown): value is SatireSuitability {
	return (
		typeof value === 'string' &&
		SATIRE_SUITABILITIES.includes(value as SatireSuitability)
	);
}

export function isCandidateStatus(value: unknown): value is CandidateStatus {
	return typeof value === 'string' && CANDIDATE_STATUSES.includes(value as CandidateStatus);
}

export function isContextOnlySourceType(sourceType: SourceType): boolean {
	return sourceType === 'SOCIAL_CONTEXT' || sourceType === 'COMMUNITY_CONTEXT';
}

export function isValidSourceAuthority(sourceTier: SourceTier, sourceType: SourceType): boolean {
	return !isContextOnlySourceType(sourceType) || sourceTier === 'CONTEXT_ONLY';
}

const candidateTransitions: Readonly<Record<CandidateStatus, readonly CandidateStatus[]>> = {
	DRAFT: ['REVIEW', 'REJECTED'],
	REVIEW: ['DRAFT', 'APPROVED', 'REJECTED'],
	APPROVED: ['REVIEW'],
	REJECTED: ['DRAFT'],
};

export function canTransitionCandidate(from: CandidateStatus, to: CandidateStatus): boolean {
	return candidateTransitions[from].includes(to);
}
