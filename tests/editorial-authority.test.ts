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
