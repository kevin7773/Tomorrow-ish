import { DEFAULT_MODEL_LIMITS } from '../ai/model-runner';
import { env } from 'cloudflare:workers';
import { getRuntimeModelConfiguration } from '../ai/runtime-model-provider';
import { D1GenerationRepository } from '../data/d1-generation-repository';
import { getArticleImageAssetStore, getArticleImageRepository } from '../data/runtime-article-image-repository';
import { getEditorialRepository } from '../data/runtime-editorial-repository';
import { getEditorialWorkflowRepository } from '../data/runtime-editorial-workflow-repository';
import type { EditorialBatchItem } from '../domain/editorial-workflow';
import type { EditorialIdentity } from '../domain/editorial';
import { getImageProvider } from '../images/runtime-image-provider';
import { isImageGenerationEnabled } from '../images/image-provider-factory';
import type { ImageProvider } from '../images/image-provider';
import { ArticleImageService } from './article-image-service';
import { getAsyncArticleImageService, getImageWebhookUrl } from './runtime-async-article-image-service';
import { GenerationService } from './generation-service';
import { EditorialWorkflowService, type FinalReviewImagePort, type WorkflowPipelinePort } from './editorial-workflow-service';
import { smokeTarget, type EditorialSmokeTarget } from './editorial-smoke-target';
import { generateWorkflowImageIfEnabled } from './workflow-image-generation';
import { authorizeImageSmokeTarget } from './image-smoke-authorization';

function slug(headline: string, id: string): string {
	const base = headline.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'story';
	return `${base}-${id.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase()}`;
}

function imageService(target: EditorialSmokeTarget | null): ArticleImageService {
	const repository = getArticleImageRepository();
	const assets = getArticleImageAssetStore();
	const asyncService = getAsyncArticleImageService(repository, assets);
	return new ArticleImageService(getEditorialRepository(), repository, getImageProvider(), assets, {
		createWebhookUrl: getImageWebhookUrl,
		processStoredWebhook: (imageId) => asyncService.processStoredWebhook(imageId).then(() => undefined),
		smokeTarget: target,
		attemptKey: env.EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY,
		authorizeSmokeTarget: (configured) => authorizeImageSmokeTarget(getEditorialWorkflowRepository(), configured),
	});
}

const reviewOnlyImageProvider: ImageProvider = {
	provider: 'review-only',
	model: 'none',
	lifecycle: 'synchronous',
	async generate() {
		throw new Error('Image generation is unavailable from the review-only service.');
	},
};

function imageReviewService(target: EditorialSmokeTarget | null): ArticleImageService {
	return new ArticleImageService(
		getEditorialRepository(),
		getArticleImageRepository(),
		reviewOnlyImageProvider,
		getArticleImageAssetStore(),
		{ smokeTarget: target },
	);
}

class RuntimePipeline implements WorkflowPipelinePort {
	async advance(item: EditorialBatchItem, guard?: { renew(): Promise<void> }): Promise<{ storyId: string; ready: boolean }> {
		const workflow = getEditorialWorkflowRepository();
		const target = smokeTarget(env.EDITORIAL_WORKFLOW_SMOKE_BATCH_ID, env.EDITORIAL_WORKFLOW_SMOKE_INTAKE_ID);
		if (item.candidateId && !item.storyId) {
			const existingStoryId = await workflow.findStoryIdByCandidate(item.candidateId);
			if (existingStoryId) {
				if (!item.leaseOwner || !(await workflow.attachExistingStory({ batchId: item.batchId, intakeId: item.intakeId,
					candidateId: item.candidateId, storyId: existingStoryId, owner: item.leaseOwner,
					at: new Date().toISOString(), eventId: crypto.randomUUID() }))) throw new Error('WORKFLOW_LEASE_LOST');
				const existingImages = await getArticleImageRepository().listByStory(existingStoryId);
				if (existingImages.some((image) => image.status === 'GENERATED' || image.status === 'APPROVED')) {
					return { storyId: existingStoryId, ready: true };
				}
				if (existingImages.some((image) => image.status === 'PENDING')) return { storyId: existingStoryId, ready: false };
				await guard?.renew();
				const generated = await generateWorkflowImageIfEnabled(env, target, existingStoryId,
					{ email: item.selectedByEmail ?? 'automation@tomorrow-ish.news' }, imageService);
				return { storyId: existingStoryId, ready: generated.status === 'DISABLED' };
			}
		}
		const generationRepository = new D1GenerationRepository(env.DB);
		const identity = { email: item.selectedByEmail ?? 'automation@tomorrow-ish.news' };
		let version = await generationRepository.findAcceptedNormalizedVersion(item.intakeId);
		if (!version) throw new Error('NORMALIZATION_REVIEW_REQUIRED');
		if (version.proposedSuitability === 'UNSUITABLE') throw new Error('NORMALIZATION_INELIGIBLE');

		const activeSelection = await workflow.findCandidateSelection(item.batchId, item.intakeId);
		if (!activeSelection || activeSelection.intakeId !== item.intakeId
			|| activeSelection.normalizedEventVersionId !== version.id) throw new Error('CANDIDATE_SELECTION_REQUIRED');
		const candidateId = activeSelection.candidateId;
		if (item.candidateId && item.candidateId !== candidateId) throw new Error('CANDIDATE_SELECTION_CONFLICT');
		if (!item.candidateId && (!item.leaseOwner
			|| !(await workflow.attachCandidate(item.batchId, item.intakeId, candidateId, item.leaseOwner, new Date().toISOString())))) {
			throw new Error('WORKFLOW_LEASE_LOST');
		}
		const model = getRuntimeModelConfiguration();
		const generation = new GenerationService(generationRepository, model.provider, {
			dailyBudgetMicrousd: model.dailyBudgetMicrousd,
			generationEnabled: model.generationEnabled,
			limits: { ...DEFAULT_MODEL_LIMITS, defaultCandidateCount: 1, maxAttempts: 1 },
			requestOwner: item.leaseOwner ?? '',
			workflowFence: item.leaseOwner ? { batchId: item.batchId, intakeId: item.intakeId, leaseOwner: item.leaseOwner } : undefined,
			beforeProviderCall: async () => guard?.renew(),
			beforePersistResult: async () => guard?.renew(),
			smokeTarget: target,
		});

		let storyId = item.storyId;
		if (!storyId) {
			storyId = await workflow.findStoryIdByCandidate(candidateId);
			if (!storyId) {
				await generation.generateArticleBody(identity, {
					candidateId, idempotencyKey: `workflow:body:v2:${item.batchId}:${item.intakeId}:attempt:${item.retryAttempt}`,
					cautionReason: version.proposedSuitability === 'SENSITIVE' ? 'Explicitly selected during intake triage.' : undefined,
				});
			}
			const context = await generationRepository.findCandidateForBodyGeneration(candidateId);
			if (!context || (!storyId && context.candidate.bodyGenerationState !== 'SUCCEEDED')) throw new Error('BODY_MISSING');
			const proposedStoryId = storyId ?? crypto.randomUUID();
			await guard?.renew();
			const now = new Date().toISOString();
			const attached = await workflow.ensureReviewStory({
				batchId: item.batchId, intakeId: item.intakeId, candidateId, storyId: proposedStoryId,
				slug: slug(context.candidate.proposedHeadline, item.intakeId), editionDate: now.slice(0, 10),
				socialExcerpt: context.candidate.proposedDeck.slice(0, 500), actorEmail: identity.email,
				owner: item.leaseOwner ?? '', at: now, eventId: crypto.randomUUID(),
			});
			if (!attached) throw new Error('STORY_CREATION_FAILED');
			storyId = attached;
		}

		const images = await getArticleImageRepository().listByStory(storyId);
		if (images.some((image) => image.status === 'GENERATED' || image.status === 'APPROVED')) return { storyId, ready: true };
		if (images.some((image) => image.status === 'PENDING')) return { storyId, ready: false };
		await guard?.renew();
		const result = await generateWorkflowImageIfEnabled(env, target, storyId, identity, imageService);
		return { storyId, ready: result.status === 'DISABLED' };
	}
}

class RuntimeFinalImages implements FinalReviewImagePort {
	async regenerate(storyId: string, identity: EditorialIdentity): Promise<void> {
		const repository = getArticleImageRepository();
		const images = await repository.listByStory(storyId);
		const current = images.find((image) => image.status === 'GENERATED' || image.status === 'REJECTED');
		const target = smokeTarget(env.EDITORIAL_WORKFLOW_SMOKE_BATCH_ID, env.EDITORIAL_WORKFLOW_SMOKE_INTAKE_ID);
		if (current) await imageReviewService(target).requestRegeneration(identity, { storyId, imageId: current.id });
		else if (!images.some((image) => ['REGENERATE_REQUESTED', 'GENERATION_FAILED', 'APPROVED'].includes(image.status))) {
			throw new Error('No governed image history is available for regeneration.');
		}
		await generateWorkflowImageIfEnabled(env, target, storyId, identity, imageService);
	}
}

function enabled(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === 'true';
}

export function getEditorialWorkflowService(): EditorialWorkflowService {
	const target = smokeTarget(env.EDITORIAL_WORKFLOW_SMOKE_BATCH_ID, env.EDITORIAL_WORKFLOW_SMOKE_INTAKE_ID);
	return new EditorialWorkflowService(getEditorialWorkflowRepository(), new RuntimePipeline(), new RuntimeFinalImages(), {
		generationEnabled: enabled(env.EDITORIAL_WORKFLOW_GENERATION_ENABLED),
		smokeTarget: target,
		imageGenerationEnabled: isImageGenerationEnabled(env),
	});
}

export function runEditorialWorkflow(limit = 3) {
	return getEditorialWorkflowService().process(limit);
}
