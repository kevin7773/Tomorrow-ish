import { describe, expect, it, vi } from 'vitest';
import type { EditorialRepository } from '../src/data/editorial-repository';
import type { EditorialStory, SatireCandidate } from '../src/domain/editorial';
import { EditorialService } from '../src/services/editorial-service';
import { publishStory } from '../src/services/publication-service';
import { EditorialValidationError } from '../src/services/validation';

const identity = { email: 'newsgoblin@tomorrow-ish.news' };

function candidate(overrides: Partial<SatireCandidate> = {}): SatireCandidate {
	return {
		id: 'candidate-1',
		sourceIntakeId: 'intake-1',
		sourceIntakeTitle: 'A factual event',
		proposedHeadline: 'Agency Forms Task Force to Review Task Forces',
		proposedDeck: 'The findings will be reviewed by a separate panel.',
		draftBodyMarkdown: 'A clearly fictional draft.',
		category: { id: 'cat-civic-life', slug: 'civic-life', name: 'Civic Life' },
		editorialNotes: '',
		status: 'APPROVED',
		createdByEmail: identity.email,
		updatedByEmail: identity.email,
		createdAt: '2026-09-10T12:00:00.000Z',
		updatedAt: '2026-09-10T12:00:00.000Z',
		convertedStoryId: null,
		originModelRunId: null,
		normalizedEventVersionId: null,
		generationOrdinal: null,
		rationale: '',
		satiricalMechanism: '',
		originKind: 'MANUAL',
		bodyGenerationState: 'NOT_REQUESTED', bodyGenerationRunId: null,
		archivedAt: null, archivedByEmail: null, archiveReason: null,
		...overrides,
	};
}

function story(overrides: Partial<EditorialStory> = {}): EditorialStory {
	return {
		id: 'story-1',
		slug: 'agency-forms-task-force',
		headline: 'Agency Forms Task Force to Review Task Forces',
		deck: 'The findings will be reviewed by a separate panel.',
		bodyMarkdown: 'A clearly fictional draft.',
		editionDate: '2026-09-11',
		publishedAt: null,
		category: { id: 'cat-civic-life', slug: 'civic-life', name: 'Civic Life' },
		status: 'APPROVED',
		socialExcerpt: 'A fictional task force convenes.',
		tags: [],
		ogImageKey: null,
		originCandidateId: 'candidate-1',
		updatedAt: '2026-09-10T12:00:00.000Z',
		...overrides,
	};
}

function repository(methods: Partial<EditorialRepository>): EditorialRepository {
	return methods as EditorialRepository;
}

describe('editorial and publication authority', () => {
	function storyEditInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: 'story-1',
			slug: 'agency-forms-task-force',
			headline: 'Agency Forms Task Force to Review Task Forces',
			deck: 'The findings will be reviewed by a separate panel.',
			bodyMarkdown: 'A revised clearly fictional draft.',
			editionDate: '2026-09-11',
			categoryId: 'cat-civic-life',
			socialExcerpt: 'A fictional task force convenes.',
			tags: '',
			...overrides,
		};
	}

	function storyEditor(existing: EditorialStory) {
		const updateStory = vi.fn().mockResolvedValue(true);
		const service = new EditorialService(repository({
			findEditorialStoryById: vi.fn().mockResolvedValue(existing),
			categoryExists: vi.fn().mockResolvedValue(true),
			updateStory,
		}), {
			now: () => '2026-09-10T13:00:00.000Z',
			createId: () => 'audit-update',
		});
		return { service, updateStory };
	}

	it('allows an authenticated body-only edit to preserve an unchanged legacy slug', async () => {
		const legacySlug = 'agency-forms--task-force';
		const { service, updateStory } = storyEditor(story({ slug: legacySlug, status: 'REVIEW' }));

		await expect(service.updateStory(identity, storyEditInput({ slug: legacySlug }))).resolves.toBeUndefined();
		expect(updateStory).toHaveBeenCalledWith(expect.objectContaining({
			id: 'story-1',
			expectedSlug: legacySlug,
			slug: legacySlug,
			bodyMarkdown: 'A revised clearly fictional draft.',
			actorEmail: identity.email,
			auditId: 'audit-update',
		}));
	});

	it.each([
		['changed invalid slug', 'replacement--slug'],
		['missing slug', undefined],
		['tampered non-string slug', 42],
		['another story legacy slug', 'other--story'],
	])('rejects %s before the audited story update', async (_label, submittedSlug) => {
		const { service, updateStory } = storyEditor(story({ slug: 'agency-forms--task-force', status: 'REVIEW' }));

		await expect(service.updateStory(identity, storyEditInput({ slug: submittedSlug }))).rejects.toBeInstanceOf(EditorialValidationError);
		expect(updateStory).not.toHaveBeenCalled();
	});

	it('validates and accepts a requested change from an existing valid slug', async () => {
		const { service, updateStory } = storyEditor(story({ status: 'REVIEW' }));

		await service.updateStory(identity, storyEditInput({ slug: 'agency-reviews-task-force' }));
		expect(updateStory).toHaveBeenCalledWith(expect.objectContaining({ slug: 'agency-reviews-task-force' }));
	});

	it('cannot substitute a valid slug already owned by another story', async () => {
		const updateStory = vi.fn().mockRejectedValue(new Error('UNIQUE constraint failed: stories.slug'));
		const service = new EditorialService(repository({
			findEditorialStoryById: vi.fn().mockResolvedValue(story({ status: 'REVIEW' })),
			categoryExists: vi.fn().mockResolvedValue(true),
			updateStory,
		}));

		await expect(service.updateStory(identity, storyEditInput({ slug: 'another-story' })))
			.rejects.toThrow(/UNIQUE constraint failed/);
		expect(updateStory).toHaveBeenCalledWith(expect.objectContaining({
			id: 'story-1',
			expectedSlug: 'agency-forms-task-force',
			slug: 'another-story',
		}));
	});

	it('keeps strict slug validation for new stories', async () => {
		const convertApprovedCandidateToDraft = vi.fn();
		const service = new EditorialService(repository({
			findCandidateById: vi.fn().mockResolvedValue(candidate()),
			convertApprovedCandidateToDraft,
		}));

		await expect(service.convertApprovedCandidateToDraft(identity, {
			candidateId: 'candidate-1',
			slug: 'new--invalid-slug',
			editionDate: '2026-09-11',
			socialExcerpt: 'A fictional task force convenes.',
		})).rejects.toBeInstanceOf(EditorialValidationError);
		expect(convertApprovedCandidateToDraft).not.toHaveBeenCalled();
	});

	it('requires an authenticated editor before preserving a legacy slug', async () => {
		const { service, updateStory } = storyEditor(story({ slug: 'agency-forms--task-force', status: 'REVIEW' }));

		await expect(service.updateStory(null as never, storyEditInput({ slug: 'agency-forms--task-force' })))
			.rejects.toThrow(/authenticated editor/i);
		expect(updateStory).not.toHaveBeenCalled();
	});

	it('converts an approved candidate through the DRAFT-only repository method', async () => {
		const convertApprovedCandidateToDraft = vi.fn().mockResolvedValue(true);
		const service = new EditorialService(
			repository({
				findCandidateById: vi.fn().mockResolvedValue(candidate()),
				convertApprovedCandidateToDraft,
			}),
			{
				now: () => '2026-09-10T13:00:00.000Z',
				createId: (() => {
					let value = 0;
					return () => `generated-${++value}`;
				})(),
			},
		);
		await expect(
			service.convertApprovedCandidateToDraft(identity, {
				candidateId: 'candidate-1',
				slug: 'agency-forms-task-force',
				editionDate: '2026-09-11',
				socialExcerpt: 'A fictional task force convenes.',
			}),
		).resolves.toBe('generated-1');
		expect(convertApprovedCandidateToDraft).toHaveBeenCalledOnce();
	});

	it('rejects duplicate conversion before attempting another insert', async () => {
		const convertApprovedCandidateToDraft = vi.fn();
		const service = new EditorialService(repository({
			findCandidateById: vi.fn().mockResolvedValue(candidate({ convertedStoryId: 'story-existing' })),
			convertApprovedCandidateToDraft,
		}));
		await expect(
			service.convertApprovedCandidateToDraft(identity, {
				candidateId: 'candidate-1',
				slug: 'unused',
				editionDate: '2026-09-11',
				socialExcerpt: 'Unused.',
			}),
		).rejects.toMatchObject({ code: 'duplicate' });
		expect(convertApprovedCandidateToDraft).not.toHaveBeenCalled();
	});

	it('does not let candidates or generic story transitions request PUBLISHED', async () => {
		const candidateTransition = vi.fn();
		const storyTransition = vi.fn();
		const service = new EditorialService(repository({
			findCandidateById: vi.fn().mockResolvedValue(candidate({ status: 'REVIEW' })),
			transitionCandidate: candidateTransition,
			findEditorialStoryById: vi.fn().mockResolvedValue(story({ status: 'APPROVED' })),
			transitionStory: storyTransition,
		}));
		await expect(
			service.transitionCandidate(identity, { id: 'candidate-1', to: 'PUBLISHED' }),
		).rejects.toBeInstanceOf(EditorialValidationError);
		await expect(
			service.transitionStory(identity, { id: 'story-1', to: 'PUBLISHED' }),
		).rejects.toThrow('dedicated publish action');
		expect(candidateTransition).not.toHaveBeenCalled();
		expect(storyTransition).not.toHaveBeenCalled();
	});

	it('publishes only an approved story with confirmation and authenticated identity', async () => {
		const publishApprovedStory = vi.fn().mockResolvedValue(true);
		const repo = repository({
			findEditorialStoryById: vi.fn().mockResolvedValue(story()),
			publishApprovedStory,
		});

		await expect(
			publishStory(repo, identity, { storyId: 'story-1', confirmation: 'PUBLISH' }, {
				now: () => '2026-09-10T14:00:00.000Z',
				createId: () => 'audit-publish',
			}),
		).resolves.toBe('2026-09-10T14:00:00.000Z');
		expect(publishApprovedStory).toHaveBeenCalledWith({
			id: 'story-1',
			actorEmail: identity.email,
			publishedAt: '2026-09-10T14:00:00.000Z',
			auditId: 'audit-publish',
		});

		await expect(
			publishStory(repo, identity, { storyId: 'story-1', confirmation: 'yes' }),
		).rejects.toThrow('Type PUBLISH');
		await expect(
			publishStory(repo, null, { storyId: 'story-1', confirmation: 'PUBLISH' }),
		).rejects.toThrow('authenticated editor');
	});
});
