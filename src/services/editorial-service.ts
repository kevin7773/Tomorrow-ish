import {
	canTransitionCandidate,
	isCandidateStatus,
	isSatireSuitability,
	isSourceTier,
	isSourceType,
	isValidSourceAuthority,
	type EditorialIdentity,
} from '../domain/editorial';
import {
	canTransitionPublication,
	isNonPublishingStatus,
} from '../domain/publication-status';
import type { EditorialRepository } from '../data/editorial-repository';
import {
	EditorialValidationError,
	editionDate,
	optionalText,
	optionalTimestamp,
	requiredText,
	score,
	sourceUrl,
	storySlug,
	tagList,
} from './validation';

export interface ServiceDependencies {
	now?: () => string;
	createId?: () => string;
}

function identityEmail(identity: EditorialIdentity | null | undefined): string {
	if (!identity?.email) {
		throw new EditorialValidationError('An authenticated editor is required.', 'unauthorized');
	}
	return identity.email.toLowerCase();
}

function archiveReason(value: unknown): string | null {
	return optionalText(value, 'Archive reason', 2_000) || null;
}

function expectedArchiveCount(value: unknown): number {
	if (typeof value !== 'string' || !/^\d+$/.test(value)) {
		throw new EditorialValidationError('Expected archive count is invalid.');
	}
	const count = Number(value);
	if (!Number.isSafeInteger(count)) {
		throw new EditorialValidationError('Expected archive count is invalid.');
	}
	return count;
}

export class EditorialService {
	private readonly now: () => string;
	private readonly createId: () => string;

	constructor(
		private readonly repository: EditorialRepository,
		dependencies: ServiceDependencies = {},
	) {
		this.now = dependencies.now ?? (() => new Date().toISOString());
		this.createId = dependencies.createId ?? (() => crypto.randomUUID());
	}

	async createIntake(
		identity: EditorialIdentity,
		input: Record<string, unknown>,
	): Promise<string> {
		const actorEmail = identityEmail(identity);
		const sourceTier = input.sourceTier;
		const sourceType = input.sourceType;
		const satireSuitability = input.satireSuitability;
		if (!isSourceTier(sourceTier) || !isSourceType(sourceType)) {
			throw new EditorialValidationError('Source authority is invalid.');
		}
		if (!isValidSourceAuthority(sourceTier, sourceType)) {
			throw new EditorialValidationError('Social and community sources must be context-only.');
		}
		if (!isSatireSuitability(satireSuitability)) {
			throw new EditorialValidationError('Satire suitability is invalid.');
		}

		const intakeId = this.createId();
		const createdAt = this.now();
		await this.repository.createIntake({
			intakeId,
			referenceId: this.createId(),
			title: requiredText(input.title, 'Title', 240),
			neutralBrief: requiredText(input.neutralBrief, 'Neutral brief', 20_000),
			significanceScore: score(input.significanceScore, 'Significance score'),
			satirePotentialScore: score(input.satirePotentialScore, 'Satire-potential score'),
			satireSuitability,
			editorialNotes: optionalText(input.editorialNotes, 'Editorial notes', 20_000),
			sourceTitle: requiredText(input.sourceTitle, 'Source title', 500),
			sourceUrl: sourceUrl(input.sourceUrl),
			publisherName: requiredText(input.publisherName, 'Publisher name', 240),
			sourceTier,
			sourceType,
			publishedAt: optionalTimestamp(input.publishedAt, 'Source publication time'),
			actorEmail,
			createdAt,
			auditIds: [this.createId(), this.createId()],
		});
		return intakeId;
	}

	async updateIntake(identity: EditorialIdentity, input: Record<string, unknown>): Promise<void> {
		const satireSuitability = input.satireSuitability;
		if (!isSatireSuitability(satireSuitability)) {
			throw new EditorialValidationError('Satire suitability is invalid.');
		}
		const updated = await this.repository.updateIntake({
			id: requiredText(input.id, 'Intake ID', 100),
			title: requiredText(input.title, 'Title', 240),
			neutralBrief: requiredText(input.neutralBrief, 'Neutral brief', 20_000),
			significanceScore: score(input.significanceScore, 'Significance score'),
			satirePotentialScore: score(input.satirePotentialScore, 'Satire-potential score'),
			satireSuitability,
			editorialNotes: optionalText(input.editorialNotes, 'Editorial notes', 20_000),
			actorEmail: identityEmail(identity),
			updatedAt: this.now(),
			auditId: this.createId(),
		});
		if (!updated) throw new EditorialValidationError('The intake was not found.', 'not-found');
	}

	async archiveUnsuitableIntake(identity: EditorialIdentity, input: Record<string, unknown>): Promise<void> {
		const id = requiredText(input.id, 'Intake ID', 100);
		const intake = await this.repository.findIntakeById(id);
		if (!intake) throw new EditorialValidationError('The intake was not found.', 'not-found');
		if (intake.archivedAt) throw new EditorialValidationError('The intake is already archived.', 'conflict');
		if (intake.satireSuitability !== 'UNSUITABLE') {
			throw new EditorialValidationError('Only an unsuitable intake can be archived.');
		}
		const changed = await this.repository.archiveUnsuitableIntake({
			id,
			actorEmail: identityEmail(identity),
			archivedAt: this.now(),
			reason: archiveReason(input.archiveReason),
			auditId: this.createId(),
		});
		if (!changed) throw new EditorialValidationError('The intake changed; reload and retry.', 'conflict');
	}

	async restoreIntake(identity: EditorialIdentity, input: Record<string, unknown>): Promise<void> {
		const id = requiredText(input.id, 'Intake ID', 100);
		const intake = await this.repository.findIntakeById(id);
		if (!intake) throw new EditorialValidationError('The intake was not found.', 'not-found');
		if (!intake.archivedAt) throw new EditorialValidationError('The intake is not archived.', 'conflict');
		const changed = await this.repository.restoreIntake({
			id,
			actorEmail: identityEmail(identity),
			restoredAt: this.now(),
			reason: archiveReason(input.archiveReason),
			auditId: this.createId(),
		});
		if (!changed) throw new EditorialValidationError('The intake changed; reload and retry.', 'conflict');
	}

	async archiveAllUnsuitableIntakes(identity: EditorialIdentity, input: Record<string, unknown>): Promise<number> {
		const actorEmail = identityEmail(identity);
		const expectedCount = expectedArchiveCount(input.expectedCount);
		const counts = await this.repository.getArchiveCounts();
		if (counts.unsuitableIntakes !== expectedCount) {
			throw new EditorialValidationError('The archive preview is stale.', 'conflict');
		}
		const affected = await this.repository.archiveAllUnsuitableIntakes({
			actorEmail,
			archivedAt: this.now(),
			reason: archiveReason(input.archiveReason),
			auditIdPrefix: this.createId(),
			expectedCount,
		});
		if (affected !== expectedCount) throw new EditorialValidationError('The archive preview is stale.', 'conflict');
		return affected;
	}

	async addSourceReference(
		identity: EditorialIdentity,
		input: Record<string, unknown>,
	): Promise<void> {
		const sourceTier = input.sourceTier;
		const sourceType = input.sourceType;
		if (!isSourceTier(sourceTier) || !isSourceType(sourceType)) {
			throw new EditorialValidationError('Source authority is invalid.');
		}
		if (!isValidSourceAuthority(sourceTier, sourceType)) {
			throw new EditorialValidationError('Social and community sources must be context-only.');
		}
		const createdAt = this.now();
		const created = await this.repository.addSourceReference({
			id: this.createId(),
			sourceIntakeId: requiredText(input.sourceIntakeId, 'Intake ID', 100),
			sourceTitle: requiredText(input.sourceTitle, 'Source title', 500),
			sourceUrl: sourceUrl(input.sourceUrl),
			publisherName: requiredText(input.publisherName, 'Publisher name', 240),
			sourceTier,
			sourceType,
			publishedAt: optionalTimestamp(input.publishedAt, 'Source publication time'),
			actorEmail: identityEmail(identity),
			createdAt,
			auditId: this.createId(),
		});
		if (!created) throw new EditorialValidationError('The intake was not found.', 'not-found');
	}

	async updateSourceReference(
		identity: EditorialIdentity,
		input: Record<string, unknown>,
	): Promise<void> {
		const sourceTier = input.sourceTier;
		const sourceType = input.sourceType;
		if (!isSourceTier(sourceTier) || !isSourceType(sourceType)) {
			throw new EditorialValidationError('Source authority is invalid.');
		}
		if (!isValidSourceAuthority(sourceTier, sourceType)) {
			throw new EditorialValidationError('Social and community sources must be context-only.');
		}
		const updated = await this.repository.updateSourceReference({
			id: requiredText(input.id, 'Source reference ID', 100),
			sourceTitle: requiredText(input.sourceTitle, 'Source title', 500),
			sourceUrl: sourceUrl(input.sourceUrl),
			publisherName: requiredText(input.publisherName, 'Publisher name', 240),
			sourceTier,
			sourceType,
			publishedAt: optionalTimestamp(input.publishedAt, 'Source publication time'),
			actorEmail: identityEmail(identity),
			updatedAt: this.now(),
			auditId: this.createId(),
		});
		if (!updated) throw new EditorialValidationError('The source was not found.', 'not-found');
	}

	async createCandidate(
		identity: EditorialIdentity,
		input: Record<string, unknown>,
	): Promise<string> {
		const createdAt = this.now();
		const id = this.createId();
		const categoryId = requiredText(input.categoryId, 'Category', 100);
		if (!(await this.repository.categoryExists(categoryId))) {
			throw new EditorialValidationError('Category is invalid.');
		}
		const created = await this.repository.createCandidate({
			id,
			sourceIntakeId: requiredText(input.sourceIntakeId, 'Intake ID', 100),
			proposedHeadline: requiredText(input.proposedHeadline, 'Headline', 300),
			proposedDeck: requiredText(input.proposedDeck, 'Deck', 1_000),
			draftBodyMarkdown: requiredText(input.draftBodyMarkdown, 'Draft body', 50_000),
			categoryId,
			editorialNotes: optionalText(input.editorialNotes, 'Editorial notes', 20_000),
			actorEmail: identityEmail(identity),
			createdAt,
			auditId: this.createId(),
		});
		if (!created) throw new EditorialValidationError('The candidate could not be created.');
		return id;
	}

	async updateCandidate(
		identity: EditorialIdentity,
		input: Record<string, unknown>,
	): Promise<void> {
		const categoryId = requiredText(input.categoryId, 'Category', 100);
		if (!(await this.repository.categoryExists(categoryId))) {
			throw new EditorialValidationError('Category is invalid.');
		}
		const updated = await this.repository.updateCandidate({
			id: requiredText(input.id, 'Candidate ID', 100),
			proposedHeadline: requiredText(input.proposedHeadline, 'Headline', 300),
			proposedDeck: requiredText(input.proposedDeck, 'Deck', 1_000),
			draftBodyMarkdown: requiredText(input.draftBodyMarkdown, 'Draft body', 50_000),
			categoryId,
			editorialNotes: optionalText(input.editorialNotes, 'Editorial notes', 20_000),
			actorEmail: identityEmail(identity),
			updatedAt: this.now(),
			auditId: this.createId(),
		});
		if (!updated) {
			throw new EditorialValidationError('The candidate is missing or already converted.');
		}
	}

	async transitionCandidate(
		identity: EditorialIdentity,
		input: Record<string, unknown>,
	): Promise<void> {
		const id = requiredText(input.id, 'Candidate ID', 100);
		const to = input.to;
		if (!isCandidateStatus(to)) throw new EditorialValidationError('Candidate status is invalid.');
		const candidate = await this.repository.findCandidateById(id);
		if (!candidate) throw new EditorialValidationError('The candidate was not found.', 'not-found');
		if (candidate.archivedAt) throw new EditorialValidationError('Restore the candidate before changing status.', 'conflict');
		if (candidate.convertedStoryId) {
			throw new EditorialValidationError('A converted candidate is immutable.');
		}
		if (!canTransitionCandidate(candidate.status, to)) {
			throw new EditorialValidationError(`Cannot move ${candidate.status} to ${to}.`);
		}
		if (to === 'REVIEW') {
			requiredText(candidate.proposedHeadline, 'Headline', 300);
			requiredText(candidate.proposedDeck, 'Deck', 1_000);
			requiredText(candidate.draftBodyMarkdown, 'Draft body', 50_000);
		}
		const changed = await this.repository.transitionCandidate({
			id,
			from: candidate.status,
			to,
			actorEmail: identityEmail(identity),
			updatedAt: this.now(),
			auditId: this.createId(),
		});
		if (!changed) throw new EditorialValidationError('The candidate changed; reload and retry.');
	}

	async archiveRejectedCandidate(identity: EditorialIdentity, input: Record<string, unknown>): Promise<void> {
		const id = requiredText(input.id, 'Candidate ID', 100);
		const candidate = await this.repository.findCandidateById(id);
		if (!candidate) throw new EditorialValidationError('The candidate was not found.', 'not-found');
		if (candidate.archivedAt) throw new EditorialValidationError('The candidate is already archived.', 'conflict');
		if (candidate.status !== 'REJECTED') {
			throw new EditorialValidationError('Only a rejected candidate can be archived.');
		}
		const changed = await this.repository.archiveRejectedCandidate({
			id,
			actorEmail: identityEmail(identity),
			archivedAt: this.now(),
			reason: archiveReason(input.archiveReason),
			auditId: this.createId(),
		});
		if (!changed) throw new EditorialValidationError('The candidate changed; reload and retry.', 'conflict');
	}

	async restoreCandidate(identity: EditorialIdentity, input: Record<string, unknown>): Promise<void> {
		const id = requiredText(input.id, 'Candidate ID', 100);
		const candidate = await this.repository.findCandidateById(id);
		if (!candidate) throw new EditorialValidationError('The candidate was not found.', 'not-found');
		if (!candidate.archivedAt) throw new EditorialValidationError('The candidate is not archived.', 'conflict');
		const changed = await this.repository.restoreCandidate({
			id,
			actorEmail: identityEmail(identity),
			restoredAt: this.now(),
			reason: archiveReason(input.archiveReason),
			auditId: this.createId(),
		});
		if (!changed) throw new EditorialValidationError('The candidate changed; reload and retry.', 'conflict');
	}

	async archiveAllRejectedCandidates(identity: EditorialIdentity, input: Record<string, unknown>): Promise<number> {
		const actorEmail = identityEmail(identity);
		const expectedCount = expectedArchiveCount(input.expectedCount);
		const counts = await this.repository.getArchiveCounts();
		if (counts.rejectedCandidates !== expectedCount) {
			throw new EditorialValidationError('The archive preview is stale.', 'conflict');
		}
		const affected = await this.repository.archiveAllRejectedCandidates({
			actorEmail,
			archivedAt: this.now(),
			reason: archiveReason(input.archiveReason),
			auditIdPrefix: this.createId(),
			expectedCount,
		});
		if (affected !== expectedCount) throw new EditorialValidationError('The archive preview is stale.', 'conflict');
		return affected;
	}

	async convertApprovedCandidateToDraft(
		identity: EditorialIdentity,
		input: Record<string, unknown>,
	): Promise<string> {
		const candidateId = requiredText(input.candidateId, 'Candidate ID', 100);
		const candidate = await this.repository.findCandidateById(candidateId);
		if (!candidate) throw new EditorialValidationError('The candidate was not found.', 'not-found');
		if (candidate.convertedStoryId) {
			throw new EditorialValidationError('This candidate has already been converted.', 'duplicate');
		}
		if (candidate.status !== 'APPROVED') {
			throw new EditorialValidationError('Only an approved candidate can become a story.');
		}

		const storyId = this.createId();
		const created = await this.repository.convertApprovedCandidateToDraft({
			candidateId,
			storyId,
			slug: storySlug(input.slug),
			editionDate: editionDate(input.editionDate),
			socialExcerpt: requiredText(input.socialExcerpt, 'Social excerpt', 500),
			actorEmail: identityEmail(identity),
			createdAt: this.now(),
			auditIds: [this.createId(), this.createId()],
		});
		if (!created) {
			throw new EditorialValidationError('The candidate changed; reload and retry.');
		}
		return storyId;
	}

	async updateStory(identity: EditorialIdentity, input: Record<string, unknown>): Promise<void> {
		const id = requiredText(input.id, 'Story ID', 100);
		const story = await this.repository.findEditorialStoryById(id);
		if (!story) throw new EditorialValidationError('The story was not found.', 'not-found');
		if (story.status === 'PUBLISHED' || story.status === 'ARCHIVED') {
			throw new EditorialValidationError('Published or archived story content is locked.');
		}
		const categoryId = requiredText(input.categoryId, 'Category', 100);
		if (!(await this.repository.categoryExists(categoryId))) {
			throw new EditorialValidationError('Category is invalid.');
		}
		const updated = await this.repository.updateStory({
			id,
			slug: storySlug(input.slug),
			headline: requiredText(input.headline, 'Headline', 300),
			deck: requiredText(input.deck, 'Deck', 1_000),
			bodyMarkdown: requiredText(input.bodyMarkdown, 'Body', 50_000),
			editionDate: editionDate(input.editionDate),
			categoryId,
			socialExcerpt: requiredText(input.socialExcerpt, 'Social excerpt', 500),
			tags: tagList(input.tags),
			actorEmail: identityEmail(identity),
			updatedAt: this.now(),
			auditId: this.createId(),
		});
		if (!updated) throw new EditorialValidationError('The story changed; reload and retry.');
	}

	async transitionStory(
		identity: EditorialIdentity,
		input: Record<string, unknown>,
	): Promise<void> {
		const id = requiredText(input.id, 'Story ID', 100);
		const to = input.to;
		if (!isNonPublishingStatus(to)) {
			throw new EditorialValidationError('Publication requires the dedicated publish action.');
		}
		const story = await this.repository.findEditorialStoryById(id);
		if (!story) throw new EditorialValidationError('The story was not found.', 'not-found');
		if (!canTransitionPublication(story.status, to)) {
			throw new EditorialValidationError(`Cannot move ${story.status} to ${to}.`);
		}
		const changed = await this.repository.transitionStory({
			id,
			from: story.status,
			to,
			actorEmail: identityEmail(identity),
			updatedAt: this.now(),
			auditId: this.createId(),
		});
		if (!changed) throw new EditorialValidationError('The story changed; reload and retry.');
	}
}
