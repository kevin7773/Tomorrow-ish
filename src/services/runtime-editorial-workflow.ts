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
import { ArticleImageService } from './article-image-service';
import { getAsyncArticleImageService, getImageWebhookUrl } from './runtime-async-article-image-service';
import { GenerationService } from './generation-service';
import { EditorialWorkflowService, type FinalReviewImagePort, type WorkflowPipelinePort } from './editorial-workflow-service';

function slug(headline: string, id: string): string {
	const base = headline.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'story';
	return `${base}-${id.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase()}`;
}

function imageService(): ArticleImageService {
	const repository = getArticleImageRepository();
	const assets = getArticleImageAssetStore();
	const asyncService = getAsyncArticleImageService(repository, assets);
	return new ArticleImageService(getEditorialRepository(), repository, getImageProvider(), assets, {
		createWebhookUrl: getImageWebhookUrl,
		processStoredWebhook: (imageId) => asyncService.processStoredWebhook(imageId).then(() => undefined),
	});
}

class RuntimePipeline implements WorkflowPipelinePort {
	async advance(item: EditorialBatchItem): Promise<{ storyId: string; ready: boolean }> {
		const workflow = getEditorialWorkflowRepository();
		const generationRepository = new D1GenerationRepository(env.DB);
		const model = getRuntimeModelConfiguration();
		const generation = new GenerationService(generationRepository, model.provider, {
			dailyBudgetMicrousd: model.dailyBudgetMicrousd,
			generationEnabled: model.generationEnabled,
			limits: { ...DEFAULT_MODEL_LIMITS, defaultCandidateCount: 1 },
		});
		const identity = { email: item.selectedByEmail ?? 'automation@tomorrow-ish.news' };
		let version = await generationRepository.findAcceptedNormalizedVersion(item.intakeId);
		if (!version) {
			const versionId = await generation.proposeNormalization(identity, item.intakeId, `workflow:normalize:v1:${item.batchId}:${item.intakeId}`);
			const proposed = await generationRepository.findNormalizedVersion(versionId);
			if (!proposed) throw new Error('NORMALIZATION_MISSING');
			await generation.reviewNormalization(identity, versionId, 'ACCEPTED', 'Intake selection authorized automatic pipeline continuation.');
			version = await generationRepository.findAcceptedNormalizedVersion(item.intakeId);
		}
		if (!version || version.proposedSuitability === 'UNSUITABLE') throw new Error('NORMALIZATION_INELIGIBLE');

		let candidateId = item.candidateId;
		if (!candidateId) {
			const runId = await generation.generateCandidates(identity, {
				intakeId: item.intakeId, normalizedEventVersionId: version.id, categoryId: item.categoryId,
				idempotencyKey: `workflow:candidate:v1:${item.batchId}:${item.intakeId}`,
				cautionAcknowledgement: version.proposedSuitability === 'SENSITIVE' ? 'ACKNOWLEDGE CAUTION' : undefined,
				editorialReason: version.proposedSuitability === 'SENSITIVE' ? 'Explicitly selected during intake triage.' : undefined,
			});
			candidateId = await workflow.findGeneratedCandidateId(item.intakeId, runId);
			if (!candidateId) throw new Error('CANDIDATE_MISSING');
			await workflow.attachCandidate(item.batchId, item.intakeId, candidateId, new Date().toISOString());
		}

		let storyId = item.storyId;
		if (!storyId) {
			await generation.generateArticleBody(identity, {
				candidateId, idempotencyKey: `workflow:body:v1:${item.batchId}:${item.intakeId}`,
				cautionReason: version.proposedSuitability === 'SENSITIVE' ? 'Explicitly selected during intake triage.' : undefined,
			});
			const context = await generationRepository.findCandidateForBodyGeneration(candidateId);
			if (!context || context.candidate.bodyGenerationState !== 'SUCCEEDED') throw new Error('BODY_MISSING');
			storyId = crypto.randomUUID();
			const now = new Date().toISOString();
			const created = await workflow.createReviewStory({
				batchId: item.batchId, intakeId: item.intakeId, candidateId, storyId,
				slug: slug(context.candidate.proposedHeadline, item.intakeId), editionDate: now.slice(0, 10),
				socialExcerpt: context.candidate.proposedDeck.slice(0, 500), actorEmail: identity.email,
				at: now, eventId: crypto.randomUUID(),
			});
			if (!created) {
				const refreshed = await workflow.findItem(item.batchId, item.intakeId);
				if (!refreshed?.storyId) throw new Error('STORY_CREATION_FAILED');
				storyId = refreshed.storyId;
			}
		}

		const images = await getArticleImageRepository().listByStory(storyId);
		if (images.some((image) => image.status === 'GENERATED' || image.status === 'APPROVED')) return { storyId, ready: true };
		if (images.some((image) => image.status === 'PENDING')) return { storyId, ready: false };
		const result = await imageService().generate(identity, { storyId });
		return { storyId, ready: result.status === 'GENERATED' };
	}
}

class RuntimeFinalImages implements FinalReviewImagePort {
	async approveLatestGenerated(storyId: string, identity: EditorialIdentity): Promise<void> {
		const repository = getArticleImageRepository();
		const images = await repository.listByStory(storyId);
		const approved = images.find((image) => image.status === 'APPROVED');
		if (approved) return;
		const generated = images.find((image) => image.status === 'GENERATED');
		if (!generated) throw new Error('A generated image is required before publication.');
		await imageService().approve(identity, { storyId, imageId: generated.id, altText: generated.altText ?? 'Tomorrow-ish article illustration.' });
	}

	async regenerate(storyId: string, identity: EditorialIdentity): Promise<void> {
		const repository = getArticleImageRepository();
		const images = await repository.listByStory(storyId);
		const current = images.find((image) => image.status === 'GENERATED' || image.status === 'REJECTED');
		if (current) await imageService().requestRegeneration(identity, { storyId, imageId: current.id });
		else if (!images.some((image) => ['REGENERATE_REQUESTED', 'GENERATION_FAILED', 'APPROVED'].includes(image.status))) {
			throw new Error('No governed image history is available for regeneration.');
		}
		await imageService().generate(identity, { storyId });
	}
}

export function getEditorialWorkflowService(): EditorialWorkflowService {
	return new EditorialWorkflowService(getEditorialWorkflowRepository(), new RuntimePipeline(), new RuntimeFinalImages());
}

export function runEditorialWorkflow(limit = 3) {
	return getEditorialWorkflowService().process(limit);
}
