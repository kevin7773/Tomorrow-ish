import { describe, expect, it, vi } from 'vitest';
import type { ArticleImageRepository } from '../src/data/article-image-repository';
import type { EditorialRepository } from '../src/data/editorial-repository';
import type { ArticleImage } from '../src/domain/article-image';
import type { EditorialStory } from '../src/domain/editorial';
import type { ImageAssetStore } from '../src/images/asset-store';
import { ImageProviderError, type ImageProvider } from '../src/images/image-provider';
import { ArticleImageService } from '../src/services/article-image-service';

const identity = { email: 'Editor@Tomorrow-ish.news' };

function story(status: EditorialStory['status'] = 'APPROVED'): EditorialStory {
	return {
		id: 'story-1', slug: 'task-force', headline: 'Agency Forms Task Force to Review Task Forces',
		deck: 'Officials gather around an absurdly long conference table to review their own review process.',
		bodyMarkdown: 'Long article body that must not be copied wholesale into an image prompt.',
		editionDate: '2026-09-11', publishedAt: null,
		category: { id: 'cat-1', slug: 'civic-life', name: 'Civic Life' }, status,
		socialExcerpt: 'A fictional task force convenes.', tags: [], ogImageKey: null,
		originCandidateId: 'candidate-1', updatedAt: '2026-09-11T12:00:00.000Z',
	};
}

function image(status: ArticleImage['status'] = 'GENERATED'): ArticleImage {
	return {
		id: 'image-1', storyId: 'story-1', provider: 'fake', model: 'fake-v1', prompt: 'Prompt',
		aspectRatio: '16:9', providerRequestId: 'request-1', assetKey: 'article-images/story-1/image-1.webp',
		contentType: 'image/webp', byteSize: 3, status, altText: 'Editorial illustration of officials at a table.',
		metadata: {}, errorClassification: null, errorMessage: null, requestedByEmail: identity.email,
		requestedAt: '2026-09-11T12:00:00.000Z', generatedAt: '2026-09-11T12:00:01.000Z',
		reviewedByEmail: null, reviewedAt: null,
	};
}

function setup(options: { status?: EditorialStory['status']; providerError?: ImageProviderError; imageStatus?: ArticleImage['status'] } = {}) {
	const editorialRepository = {
		findEditorialStoryById: vi.fn().mockResolvedValue(story(options.status)),
	} as unknown as EditorialRepository;
	const imageRepository = {
		findById: vi.fn().mockResolvedValue(image(options.imageStatus)),
		findByProviderRequestId: vi.fn().mockResolvedValue(null),
		hasPendingForStory: vi.fn().mockResolvedValue(false),
		recordGenerated: vi.fn().mockResolvedValue(true),
		recordFailure: vi.fn().mockResolvedValue(true),
		recordPending: vi.fn().mockResolvedValue(true),
		attachSubmission: vi.fn().mockResolvedValue(true),
		completePending: vi.fn().mockResolvedValue(true),
		failPending: vi.fn().mockResolvedValue(true),
		recordWebhook: vi.fn().mockResolvedValue('created'),
		findWebhook: vi.fn().mockResolvedValue(null),
		claimWebhook: vi.fn().mockResolvedValue(true),
		releaseWebhook: vi.fn().mockResolvedValue(undefined),
		markWebhookProcessed: vi.fn().mockResolvedValue(undefined),
		approve: vi.fn().mockResolvedValue(true),
		transition: vi.fn().mockResolvedValue(true),
	} as unknown as ArticleImageRepository;
	const provider: ImageProvider = {
		provider: 'fake', model: 'fake-v1', lifecycle: 'synchronous',
		generate: options.providerError
			? vi.fn().mockRejectedValue(options.providerError)
			: vi.fn().mockResolvedValue({
				provider: 'fake', model: 'fake-v1', providerRequestId: 'request-1',
				bytes: new Uint8Array([1, 2, 3]).buffer, contentType: 'image/webp', fileExtension: 'webp',
				generatedAt: '2026-09-11T12:00:01.000Z', metadata: { seed: 42 },
			}),
	};
	const assetStore: ImageAssetStore = {
		put: vi.fn().mockResolvedValue({ key: 'article-images/story-1/id-1.webp', contentType: 'image/webp', byteSize: 3 }),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	let id = 0;
	const service = new ArticleImageService(editorialRepository, imageRepository, provider, assetStore, {
		now: () => '2026-09-11T12:00:00.000Z', createId: () => `id-${++id}`,
	});
	return { service, editorialRepository, imageRepository, provider, assetStore };
}

describe('governed article image service', () => {
	it.each(['DRAFT', 'REVIEW', 'PUBLISHED', 'REJECTED', 'ARCHIVED'] as const)('blocks paid generation for a %s story', async (status) => {
		const { service, provider } = setup({ status });
		await expect(service.generate(identity, { storyId: 'story-1' })).rejects.toThrow('Only an approved story');
		expect(provider.generate).not.toHaveBeenCalled();
	});

	it('generates through the provider abstraction, stores the asset, and persists exact provenance unapproved', async () => {
		const { service, imageRepository, provider, assetStore } = setup();
		await expect(service.generate(identity, { storyId: 'story-1' })).resolves.toEqual({ imageId: 'id-1', status: 'GENERATED' });
		expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ aspectRatio: '16:9' }));
		expect(assetStore.put).toHaveBeenCalledOnce();
		expect(imageRepository.recordGenerated).toHaveBeenCalledWith(expect.objectContaining({
			id: 'id-1', storyId: 'story-1', provider: 'fake', model: 'fake-v1',
			providerRequestId: 'request-1', aspectRatio: '16:9', requestedByEmail: 'editor@tomorrow-ish.news',
			altText: expect.stringContaining('Editorial illustration'), prompt: expect.stringContaining('clearly illustrative'),
		}));
		const record = vi.mocked(imageRepository.recordGenerated).mock.calls[0][0];
		expect(record.prompt).not.toContain('Long article body');
	});

	it('records provider failure without changing editorial state or automatically retrying', async () => {
		const failure = new ImageProviderError('Provider timed out.', 'PROVIDER_TIMEOUT', 'request-9', { status: 'processing' });
		const { service, editorialRepository, imageRepository, provider, assetStore } = setup({ providerError: failure });
		await expect(service.generate(identity, { storyId: 'story-1' })).rejects.toBe(failure);
		expect(provider.generate).toHaveBeenCalledOnce();
		expect(assetStore.put).not.toHaveBeenCalled();
		expect(imageRepository.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
			errorClassification: 'PROVIDER_TIMEOUT', providerRequestId: 'request-9',
		}));
		expect(editorialRepository.findEditorialStoryById).toHaveBeenCalledOnce();
	});

	it('cleans the deterministic key and records failure when durable storage fails', async () => {
		const { service, imageRepository, assetStore } = setup();
		vi.mocked(assetStore.put).mockRejectedValueOnce(new Error('R2 unavailable'));
		await expect(service.generate(identity, { storyId: 'story-1' }))
			.rejects.toMatchObject({ failureClassification: 'ASSET_STORAGE_FAILED' });
		expect(assetStore.delete).toHaveBeenCalledWith('article-images/story-1/id-1.webp');
		expect(imageRepository.recordGenerated).not.toHaveBeenCalled();
		expect(imageRepository.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
			errorClassification: 'ASSET_STORAGE_FAILED', providerRequestId: 'request-1',
		}));
	});

	it('removes a stored object if successful-generation persistence throws', async () => {
		const { service, imageRepository, assetStore } = setup();
		vi.mocked(imageRepository.recordGenerated).mockRejectedValueOnce(new Error('D1 unavailable'));
		await expect(service.generate(identity, { storyId: 'story-1' })).rejects.toThrow('D1 unavailable');
		expect(assetStore.delete).toHaveBeenCalledWith('article-images/story-1/id-1.webp');
		expect(imageRepository.recordFailure).not.toHaveBeenCalled();
	});

	it('removes a stored object if the story persistence guard no longer matches', async () => {
		const { service, imageRepository, assetStore } = setup();
		vi.mocked(imageRepository.recordGenerated).mockResolvedValueOnce(false);
		await expect(service.generate(identity, { storyId: 'story-1' })).rejects.toThrow('story changed');
		expect(assetStore.delete).toHaveBeenCalledWith('article-images/story-1/id-1.webp');
	});

	it('approves only a generated image and persists mandatory alt text', async () => {
		const { service, imageRepository } = setup();
		await service.approve(identity, { storyId: 'story-1', imageId: 'image-1', altText: 'Officials examining paperwork at a long table.' });
		expect(imageRepository.approve).toHaveBeenCalledWith(expect.objectContaining({
			imageId: 'image-1', storyId: 'story-1', altText: 'Officials examining paperwork at a long table.',
		}));
		await expect(service.approve(identity, { storyId: 'story-1', imageId: 'image-1', altText: ' ' })).rejects.toThrow('Alt text is required');
	});

	it('rejects and requests regeneration by lifecycle transition without deleting history or generating automatically', async () => {
		const rejected = setup();
		await rejected.service.reject(identity, { storyId: 'story-1', imageId: 'image-1' });
		expect(rejected.imageRepository.transition).toHaveBeenCalledWith(expect.objectContaining({ from: 'GENERATED', to: 'REJECTED' }));
		expect(rejected.provider.generate).not.toHaveBeenCalled();

		const regenerate = setup({ imageStatus: 'REJECTED' });
		await regenerate.service.requestRegeneration(identity, { storyId: 'story-1', imageId: 'image-1' });
		expect(regenerate.imageRepository.transition).toHaveBeenCalledWith(expect.objectContaining({ from: 'REJECTED', to: 'REGENERATE_REQUESTED' }));
		expect(regenerate.provider.generate).not.toHaveBeenCalled();
	});

	it('does not reject or regenerate an approved image', async () => {
		const approved = setup({ imageStatus: 'APPROVED' });
		await expect(approved.service.reject(identity, { storyId: 'story-1', imageId: 'image-1' }))
			.rejects.toThrow('not available');
		await expect(approved.service.requestRegeneration(identity, { storyId: 'story-1', imageId: 'image-1' }))
			.rejects.toThrow('Only an unapproved image');
		expect(approved.imageRepository.transition).not.toHaveBeenCalled();
	});

	it('persists PENDING before submitting one asynchronous provider request', async () => {
		const editorialRepository = {
			findEditorialStoryById: vi.fn().mockResolvedValue(story()),
		} as unknown as EditorialRepository;
		const imageRepository = {
			findById: vi.fn().mockResolvedValue(image('PENDING')),
			hasPendingForStory: vi.fn().mockResolvedValue(false),
			recordPending: vi.fn().mockResolvedValue(true),
			attachSubmission: vi.fn().mockResolvedValue(true),
			failPending: vi.fn().mockResolvedValue(true),
		} as unknown as ArticleImageRepository;
		const provider: ImageProvider = {
			provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2', lifecycle: 'asynchronous',
			submit: vi.fn().mockResolvedValue({
				provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2',
				providerRequestId: 'run-1', metadata: { submissionState: 'queued' },
			}),
		};
		const assetStore = { put: vi.fn(), delete: vi.fn() } as unknown as ImageAssetStore;
		let id = 0;
		const processStoredWebhook = vi.fn().mockResolvedValue(undefined);
		const service = new ArticleImageService(editorialRepository, imageRepository, provider, assetStore, {
			now: () => '2026-09-11T12:00:00.000Z', createId: () => `id-${++id}`,
			createWebhookUrl: vi.fn().mockResolvedValue('https://tomorrow-ish.news/api/image-generation/webhook/id-1?signature=safe'),
			processStoredWebhook,
		});

		await expect(service.generate(identity, { storyId: 'story-1' })).resolves.toEqual({ imageId: 'id-1', status: 'PENDING' });
		expect(imageRepository.recordPending).toHaveBeenCalledWith(expect.objectContaining({
			id: 'id-1', storyId: 'story-1', provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2',
			altText: expect.stringContaining('Editorial illustration'),
		}));
		expect(provider.submit).toHaveBeenCalledOnce();
		expect(vi.mocked(imageRepository.recordPending).mock.invocationCallOrder[0])
			.toBeLessThan(vi.mocked(provider.submit).mock.invocationCallOrder[0]);
		expect(imageRepository.attachSubmission).toHaveBeenCalledWith(expect.objectContaining({ providerRequestId: 'run-1' }));
		expect(processStoredWebhook).toHaveBeenCalledWith('id-1');
		expect(assetStore.put).not.toHaveBeenCalled();
	});

	it('keeps an accepted background submission pending when no run ID is returned initially', async () => {
		const editorialRepository = {
			findEditorialStoryById: vi.fn().mockResolvedValue(story()),
		} as unknown as EditorialRepository;
		const pending = { ...image('PENDING'), providerRequestId: null };
		const imageRepository = {
			findById: vi.fn().mockResolvedValue(pending),
			hasPendingForStory: vi.fn().mockResolvedValue(false),
			recordPending: vi.fn().mockResolvedValue(true),
			attachSubmission: vi.fn(),
			failPending: vi.fn().mockResolvedValue(true),
		} as unknown as ArticleImageRepository;
		const provider: ImageProvider = {
			provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2', lifecycle: 'asynchronous',
			submit: vi.fn().mockResolvedValue({
				provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2', providerRequestId: null,
				metadata: { submissionAccepted: true },
			}),
		};
		const processStoredWebhook = vi.fn().mockResolvedValue(undefined);
		const service = new ArticleImageService(editorialRepository, imageRepository, provider, {
			put: vi.fn(), delete: vi.fn(),
		}, {
			createId: () => 'image-accepted',
			createWebhookUrl: vi.fn().mockResolvedValue('https://tomorrow-ish.news/callback?signature=safe'),
			processStoredWebhook,
		});

		await expect(service.generate(identity, { storyId: 'story-1' })).resolves.toEqual({
			imageId: 'image-accepted', status: 'PENDING',
		});
		expect(imageRepository.attachSubmission).not.toHaveBeenCalled();
		expect(imageRepository.failPending).not.toHaveBeenCalled();
		expect(processStoredWebhook).toHaveBeenCalledWith('image-accepted');
		expect(provider.submit).toHaveBeenCalledOnce();
	});

	it('blocks another paid submission while the story has a pending request', async () => {
		const state = setup();
		vi.mocked(state.imageRepository.hasPendingForStory).mockResolvedValueOnce(true);
		await expect(state.service.generate(identity, { storyId: 'story-1' })).rejects.toThrow('already pending');
		expect(state.provider.generate).not.toHaveBeenCalled();
		expect(state.imageRepository.recordPending).not.toHaveBeenCalled();
	});

	it('marks a pre-acceptance asynchronous submission failure without retrying', async () => {
		const editorialRepository = {
			findEditorialStoryById: vi.fn().mockResolvedValue(story()),
		} as unknown as EditorialRepository;
		const imageRepository = {
			hasPendingForStory: vi.fn().mockResolvedValue(false),
			recordPending: vi.fn().mockResolvedValue(true),
			failPending: vi.fn().mockResolvedValue(true),
		} as unknown as ArticleImageRepository;
		const failure = new ImageProviderError('Gateway unavailable.', 'PROVIDER_REQUEST', null, { stage: 'submission' });
		const provider: ImageProvider = {
			provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2', lifecycle: 'asynchronous',
			submit: vi.fn().mockRejectedValue(failure),
		};
		const service = new ArticleImageService(editorialRepository, imageRepository, provider, {
			put: vi.fn(), delete: vi.fn(),
		}, {
			createId: (() => { let id = 0; return () => `id-${++id}`; })(),
			createWebhookUrl: vi.fn().mockResolvedValue('https://tomorrow-ish.news/callback?signature=safe'),
		});

		await expect(service.generate(identity, { storyId: 'story-1' })).rejects.toBe(failure);
		expect(provider.submit).toHaveBeenCalledOnce();
		expect(imageRepository.failPending).toHaveBeenCalledWith(expect.objectContaining({
			imageId: 'id-1', providerRequestId: null, errorClassification: 'PROVIDER_REQUEST',
		}));
	});

	it('validates webhook configuration before persisting or submitting an asynchronous request', async () => {
		const editorialRepository = {
			findEditorialStoryById: vi.fn().mockResolvedValue(story()),
		} as unknown as EditorialRepository;
		const imageRepository = {
			hasPendingForStory: vi.fn().mockResolvedValue(false), recordPending: vi.fn(),
		} as unknown as ArticleImageRepository;
		const provider: ImageProvider = {
			provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2', lifecycle: 'asynchronous', submit: vi.fn(),
		};
		const service = new ArticleImageService(editorialRepository, imageRepository, provider, {
			put: vi.fn(), delete: vi.fn(),
		}, { createId: () => 'image-1', createWebhookUrl: vi.fn().mockRejectedValue(new Error('missing secret')) });

		await expect(service.generate(identity, { storyId: 'story-1' }))
			.rejects.toMatchObject({ failureClassification: 'PROVIDER_CONFIGURATION' });
		expect(imageRepository.recordPending).not.toHaveBeenCalled();
		expect(provider.submit).not.toHaveBeenCalled();
	});

	it('closes an accepted request safely when provider request-ID persistence fails', async () => {
		const editorialRepository = {
			findEditorialStoryById: vi.fn().mockResolvedValue(story()),
		} as unknown as EditorialRepository;
		const imageRepository = {
			hasPendingForStory: vi.fn().mockResolvedValue(false),
			recordPending: vi.fn().mockResolvedValue(true),
			attachSubmission: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
			failPending: vi.fn().mockResolvedValue(true),
		} as unknown as ArticleImageRepository;
		const provider: ImageProvider = {
			provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2', lifecycle: 'asynchronous',
			submit: vi.fn().mockResolvedValue({
				provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2', providerRequestId: 'run-accepted', metadata: {},
			}),
		};
		const service = new ArticleImageService(editorialRepository, imageRepository, provider, {
			put: vi.fn(), delete: vi.fn(),
		}, { createId: () => 'image-1', createWebhookUrl: vi.fn().mockResolvedValue('https://tomorrow-ish.news/callback') });

		await expect(service.generate(identity, { storyId: 'story-1' })).rejects.toMatchObject({
			failureClassification: 'PROVIDER_REQUEST', providerRequestId: 'run-accepted',
		});
		expect(provider.submit).toHaveBeenCalledOnce();
		expect(imageRepository.failPending).toHaveBeenCalledWith(expect.objectContaining({
			imageId: 'image-1', providerRequestId: 'run-accepted',
			metadata: { stage: 'submission-persistence' },
		}));
	});

	it('manually closes a stale pending request without deleting provenance or calling a provider', async () => {
		const pending = {
			...image('PENDING'), assetKey: null, contentType: null, byteSize: null, generatedAt: null,
			providerRequestId: 'run-stale', requestedAt: '2026-09-11T10:00:00.000Z',
		};
		const editorialRepository = {
			findEditorialStoryById: vi.fn().mockResolvedValue(story()),
		} as unknown as EditorialRepository;
		const imageRepository = {
			findById: vi.fn().mockResolvedValue(pending),
			findWebhook: vi.fn().mockResolvedValue(null),
			failPending: vi.fn().mockResolvedValue(true),
		} as unknown as ArticleImageRepository;
		const provider = {
			provider: 'unused', model: 'unused', lifecycle: 'synchronous' as const, generate: vi.fn(),
		};
		const service = new ArticleImageService(editorialRepository, imageRepository, provider, {
			put: vi.fn(), delete: vi.fn(),
		}, { now: () => '2026-09-11T12:00:00.000Z', createId: () => 'audit-1' });

		await expect(service.resolveStalePending(identity, { storyId: 'story-1', imageId: 'image-1' }))
			.resolves.toBe('GENERATION_FAILED');
		expect(imageRepository.failPending).toHaveBeenCalledWith(expect.objectContaining({
			imageId: 'image-1', providerRequestId: 'run-stale', actorEmail: 'editor@tomorrow-ish.news',
			errorClassification: 'STALE_PENDING', metadata: expect.objectContaining({ manualRecovery: true }),
		}));
		expect(provider.generate).not.toHaveBeenCalled();
	});

	it('recovers and processes a delivered early callback instead of submitting or discarding it', async () => {
		const pending = {
			...image('PENDING'), assetKey: null, contentType: null, byteSize: null, generatedAt: null,
			providerRequestId: null, requestedAt: '2026-09-11T10:00:00.000Z',
		};
		const generated = { ...pending, providerRequestId: 'run-early', status: 'GENERATED' as const };
		const editorialRepository = {
			findEditorialStoryById: vi.fn().mockResolvedValue(story()),
		} as unknown as EditorialRepository;
		const imageRepository = {
			findById: vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(generated),
			findWebhook: vi.fn().mockResolvedValue({
				imageId: 'image-1', providerRequestId: 'run-early', outcome: 'SUCCESS', resultUrl: 'https://asset.example.r2.dev/image.webp',
				metadata: {}, errorClassification: null, errorMessage: null, receivedAt: '2026-09-11T10:01:00.000Z', processingState: 'RECEIVED',
			}),
			attachSubmission: vi.fn().mockResolvedValue(true),
		} as unknown as ArticleImageRepository;
		const processStoredWebhook = vi.fn().mockResolvedValue(undefined);
		const provider = {
			provider: 'unused', model: 'unused', lifecycle: 'synchronous' as const, generate: vi.fn(),
		};
		const service = new ArticleImageService(editorialRepository, imageRepository, provider, {
			put: vi.fn(), delete: vi.fn(),
		}, {
			now: () => '2026-09-11T12:00:00.000Z', createId: () => 'audit-1', processStoredWebhook,
		});

		await expect(service.resolveStalePending(identity, { storyId: 'story-1', imageId: 'image-1' }))
			.resolves.toBe('GENERATED');
		expect(imageRepository.attachSubmission).toHaveBeenCalledWith(expect.objectContaining({
			imageId: 'image-1', providerRequestId: 'run-early', metadata: expect.objectContaining({ recoveredFromWebhook: true }),
		}));
		expect(processStoredWebhook).toHaveBeenCalledWith('image-1');
		expect(provider.generate).not.toHaveBeenCalled();
	});

	it('closes a stale claimed callback without racing a second completion worker', async () => {
		const pending = {
			...image('PENDING'), assetKey: null, contentType: null, byteSize: null, generatedAt: null,
			providerRequestId: 'run-processing', requestedAt: '2026-09-11T10:00:00.000Z',
		};
		const editorialRepository = {
			findEditorialStoryById: vi.fn().mockResolvedValue(story()),
		} as unknown as EditorialRepository;
		const imageRepository = {
			findById: vi.fn().mockResolvedValue(pending),
			findWebhook: vi.fn().mockResolvedValue({
				imageId: 'image-1', providerRequestId: 'run-processing', outcome: 'SUCCESS',
				resultUrl: 'https://asset.example.r2.dev/image.webp', metadata: { callbackState: 'completed' },
				errorClassification: null, errorMessage: null, receivedAt: '2026-09-11T10:01:00.000Z', processingState: 'PROCESSING',
			}),
			failPending: vi.fn().mockResolvedValue(true),
			markWebhookProcessed: vi.fn().mockResolvedValue(undefined),
		} as unknown as ArticleImageRepository;
		const processStoredWebhook = vi.fn();
		const provider = {
			provider: 'unused', model: 'unused', lifecycle: 'synchronous' as const, generate: vi.fn(),
		};
		const service = new ArticleImageService(editorialRepository, imageRepository, provider, {
			put: vi.fn(), delete: vi.fn(),
		}, { now: () => '2026-09-11T12:00:00.000Z', createId: () => 'audit-1', processStoredWebhook });

		await expect(service.resolveStalePending(identity, { storyId: 'story-1', imageId: 'image-1' }))
			.resolves.toBe('GENERATION_FAILED');
		expect(processStoredWebhook).not.toHaveBeenCalled();
		expect(imageRepository.failPending).toHaveBeenCalledWith(expect.objectContaining({
			providerRequestId: 'run-processing', errorClassification: 'STALE_PENDING',
		}));
		expect(imageRepository.markWebhookProcessed).toHaveBeenCalledWith('image-1', 'run-processing');
	});

	it('does not allow manual pending recovery before the one-hour threshold', async () => {
		const pending = {
			...image('PENDING'), assetKey: null, contentType: null, byteSize: null, generatedAt: null,
			requestedAt: '2026-09-11T11:30:00.000Z',
		};
		const editorialRepository = {
			findEditorialStoryById: vi.fn().mockResolvedValue(story()),
		} as unknown as EditorialRepository;
		const imageRepository = {
			findById: vi.fn().mockResolvedValue(pending), findWebhook: vi.fn(), failPending: vi.fn(),
		} as unknown as ArticleImageRepository;
		const service = new ArticleImageService(editorialRepository, imageRepository, {
			provider: 'unused', model: 'unused', lifecycle: 'synchronous', generate: vi.fn(),
		}, { put: vi.fn(), delete: vi.fn() }, { now: () => '2026-09-11T12:00:00.000Z' });

		await expect(service.resolveStalePending(identity, { storyId: 'story-1', imageId: 'image-1' }))
			.rejects.toThrow('only after one hour');
		expect(imageRepository.findWebhook).not.toHaveBeenCalled();
		expect(imageRepository.failPending).not.toHaveBeenCalled();
	});
});
