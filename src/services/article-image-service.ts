import type { ArticleImageRepository } from '../data/article-image-repository';
import type { EditorialRepository } from '../data/editorial-repository';
import type { EditorialIdentity } from '../domain/editorial';
import {
	produceArticleImagePrompt,
	validateImageVisualDirection,
} from '../images/article-image-prompt';
import type { ImageAssetStore } from '../images/asset-store';
import { estimateSmokeImageCost, type ImageCostEstimate } from '../images/image-generation-pricing';
import { ImageProviderError, type ImageProvider } from '../images/image-provider';
import { EditorialValidationError, requiredText } from './validation';
import { isSmokeTargetIntake, type EditorialSmokeTarget } from './editorial-smoke-target';

export interface ArticleImageServiceDependencies {
	now?: () => string;
	createId?: () => string;
	createWebhookUrl?: (imageId: string) => Promise<string>;
	processStoredWebhook?: (imageId: string) => Promise<void>;
	smokeTarget?: EditorialSmokeTarget | null;
	attemptKey?: string;
	authorizeSmokeTarget?: (target: EditorialSmokeTarget) => Promise<boolean>;
	estimateCost?: (provider: Pick<ImageProvider, 'provider' | 'model' | 'generationProfile'>, prompt: string, aspectRatio: string) => ImageCostEstimate;
}

export interface ArticleImageGenerationResult {
	imageId: string;
	status: 'PENDING' | 'GENERATED' | 'GENERATION_FAILED';
}

export const STALE_PENDING_MINIMUM_MS = 60 * 60 * 1000;

export function governedImageVisualDirection(value: unknown): string {
	const direction = requiredText(value, 'Visual direction', 600);
	try {
		return validateImageVisualDirection(direction);
	} catch (error) {
		throw new EditorialValidationError(error instanceof Error ? error.message : 'Visual direction is invalid.');
	}
}

export function assertImageAttemptHistoryAllowsSubmission(images: readonly { status: string }[]): void {
	if (images.length > 0 && images[0].status !== 'REGENERATE_REQUESTED') {
		throw new EditorialValidationError(
			'A subsequent image attempt requires an explicit Request another version transition.',
			'conflict',
		);
	}
}

function actor(identity: EditorialIdentity | null | undefined): string {
	if (!identity?.email) throw new EditorialValidationError('An authenticated editor is required.', 'unauthorized');
	return identity.email.toLowerCase();
}

function isDefinitiveSubmissionFailure(error: ImageProviderError): boolean {
	return error.failureClassification === 'PROVIDER_CONFIGURATION'
		|| error.failureClassification === 'PROVIDER_AUTHENTICATION'
		|| typeof error.metadata.httpStatus === 'number';
}

async function deleteAssetBestEffort(assetStore: ImageAssetStore, key: string): Promise<boolean> {
	try {
		await assetStore.delete(key);
		return true;
	} catch {
		return false;
	}
}

export class ArticleImageService {
	private readonly now: () => string;
	private readonly createId: () => string;
	private readonly createWebhookUrl?: (imageId: string) => Promise<string>;
	private readonly processStoredWebhook?: (imageId: string) => Promise<void>;
	private readonly smokeTarget: EditorialSmokeTarget | null | undefined;
	private readonly attemptKey: string | undefined;
	private readonly authorizeSmokeTarget?: (target: EditorialSmokeTarget) => Promise<boolean>;
	private readonly estimateCost: NonNullable<ArticleImageServiceDependencies['estimateCost']>;

	constructor(
		private readonly editorialRepository: EditorialRepository,
		private readonly imageRepository: ArticleImageRepository,
		private readonly provider: ImageProvider,
		private readonly assetStore: ImageAssetStore,
		dependencies: ArticleImageServiceDependencies = {},
	) {
		this.now = dependencies.now ?? (() => new Date().toISOString());
		this.createId = dependencies.createId ?? (() => crypto.randomUUID());
		this.createWebhookUrl = dependencies.createWebhookUrl;
		this.processStoredWebhook = dependencies.processStoredWebhook;
		this.smokeTarget = dependencies.smokeTarget;
		this.attemptKey = dependencies.attemptKey;
		this.authorizeSmokeTarget = dependencies.authorizeSmokeTarget;
		this.estimateCost = dependencies.estimateCost ?? estimateSmokeImageCost;
	}

	async generate(
		identity: EditorialIdentity,
		input: { storyId: unknown; visualDirection?: unknown },
	): Promise<ArticleImageGenerationResult> {
		const requestedByEmail = actor(identity);
		const storyId = requiredText(input.storyId, 'Story ID', 100);
		const story = await this.editorialRepository.findEditorialStoryById(storyId);
		if (!story) throw new EditorialValidationError('The story was not found.', 'not-found');
		if (this.smokeTarget !== undefined) {
			const candidate = story.originCandidateId
				? await this.editorialRepository.findCandidateById(story.originCandidateId)
				: null;
			if (!this.smokeTarget || !candidate
				|| story.id !== this.smokeTarget.storyId
				|| story.originCandidateId !== this.smokeTarget.candidateId
				|| candidate.id !== this.smokeTarget.candidateId
				|| !isSmokeTargetIntake(this.smokeTarget, candidate.sourceIntakeId)
				|| !this.authorizeSmokeTarget
				|| !await this.authorizeSmokeTarget(this.smokeTarget)) {
				throw new EditorialValidationError('Image generation is outside the configured smoke target.', 'conflict');
			}
		}
		const visualDirection = this.smokeTarget !== undefined
			? governedImageVisualDirection(input.visualDirection)
			: undefined;
		if (story.status !== 'REVIEW' && story.status !== 'APPROVED') {
			throw new EditorialValidationError('Only a story in final review can request paid image generation.');
		}
		if (await this.imageRepository.hasPendingForStory(storyId)) {
			throw new EditorialValidationError('An image generation is already pending for this story.', 'conflict');
		}
		assertImageAttemptHistoryAllowsSubmission(await this.imageRepository.listByStory(storyId));

		const id = this.createId();
		const requestedAt = this.now();
		let promptGovernance;
		if (story.originCandidateId) {
			const candidate = await this.editorialRepository.findCandidateById(story.originCandidateId);
			if (!candidate) throw new EditorialValidationError('The story image governance record was not found.', 'conflict');
			const intake = await this.editorialRepository.findIntakeById(candidate.sourceIntakeId);
			if (!intake) throw new EditorialValidationError('The story image source authority was not found.', 'conflict');
			promptGovernance = {
				satireSuitability: intake.satireSuitability,
				guardrailFlags: intake.guardrailFlags,
				editorialCautionDirection: candidate.editorialNotes,
				satiricalMechanism: candidate.satiricalMechanism,
			};
		}
		const prompt = produceArticleImagePrompt(story, promptGovernance, visualDirection);
		const aspectRatio = this.provider.generationProfile?.aspectRatio ?? '16:9';
		if (!this.attemptKey || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{15,199}$/.test(this.attemptKey)) {
			throw new ImageProviderError('The image attempt key is missing or invalid.', 'PROVIDER_CONFIGURATION');
		}
		const cost = this.estimateCost(this.provider, prompt.prompt, aspectRatio);
		if (this.provider.lifecycle === 'asynchronous') {
			if (!this.createWebhookUrl) {
				throw new ImageProviderError('Asynchronous image callbacks are not configured.', 'PROVIDER_CONFIGURATION');
			}
			let webhookUrl: string;
			try {
				webhookUrl = await this.createWebhookUrl(id);
			} catch {
				throw new ImageProviderError(
					'Asynchronous image callbacks are not configured.',
					'PROVIDER_CONFIGURATION',
				);
			}
			const pending = await this.imageRepository.recordPending({
				id,
				storyId,
				provider: this.provider.provider,
				model: this.provider.model,
				prompt: prompt.prompt,
				promptVersion: prompt.promptVersion,
				aspectRatio,
				attemptKey: this.attemptKey,
				estimatedCostMicrousd: cost.estimatedCostMicrousd,
				pricingBasis: cost.basis,
				altText: prompt.proposedAltText,
				requestedByEmail,
				requestedAt,
				auditId: this.createId(),
			});
			if (!pending) {
				throw new EditorialValidationError('The story changed or an image generation is already pending.', 'conflict');
			}

			let submittedRequestId: string | null = null;
			try {
				const submitted = await this.provider.submit({
					prompt: prompt.prompt,
					aspectRatio,
					webhookUrl,
				});
				submittedRequestId = submitted.providerRequestId;
				if (submitted.providerRequestId) {
					const attached = await this.imageRepository.attachSubmission({
						imageId: id,
						providerRequestId: submitted.providerRequestId,
						metadata: submitted.metadata,
						submittedAt: this.now(),
						auditId: this.createId(),
					});
					if (!attached) {
						const raced = await this.imageRepository.findById(id);
						if (raced?.providerRequestId !== submitted.providerRequestId) {
							throw new ImageProviderError(
								'The accepted provider request could not be attached locally.',
								'PROVIDER_REQUEST',
								submitted.providerRequestId,
								{ stage: 'submission-persistence', submissionAccepted: true },
							);
						}
					}
				}
				await this.processStoredWebhook?.(id);
				const current = await this.imageRepository.findById(id);
				return {
					imageId: id,
					status: current?.status === 'GENERATED' || current?.status === 'GENERATION_FAILED'
						? current.status
						: 'PENDING',
				};
			} catch (error) {
				if (error instanceof ImageProviderError && isDefinitiveSubmissionFailure(error)) {
					await this.imageRepository.failPending({
						imageId: id,
						providerRequestId: error.providerRequestId ?? submittedRequestId,
						metadata: error.metadata,
						errorClassification: error.failureClassification,
						errorMessage: error.message.slice(0, 500),
						failedAt: this.now(),
						auditId: this.createId(),
					});
				} else if (!(error instanceof EditorialValidationError)) {
					const safeFailure = error instanceof ImageProviderError ? error : new ImageProviderError(
						'The asynchronous image request has an uncertain provider outcome.',
						'PROVIDER_REQUEST', submittedRequestId,
						{
							stage: submittedRequestId ? 'submission-persistence' : 'submission',
							...(submittedRequestId ? { submissionAccepted: true } : {}),
						},
					);
					await this.imageRepository.markPendingAmbiguous({
						imageId: id,
						providerRequestId: safeFailure.providerRequestId ?? submittedRequestId,
						metadata: safeFailure.metadata,
						errorClassification: safeFailure.failureClassification,
						errorMessage: safeFailure.message,
						at: this.now(),
						auditId: this.createId(),
					});
					if (!(error instanceof ImageProviderError)) throw safeFailure;
				}
				throw error;
			}
		}

		let providerRequestId: string | null = null;
		let providerMetadata: Record<string, unknown> = {};
		try {
			const generated = await this.provider.generate({ prompt: prompt.prompt, aspectRatio });
			providerRequestId = generated.providerRequestId;
			providerMetadata = generated.metadata;
			const assetKey = `article-images/${story.id}/${id}.${generated.fileExtension}`;
			let stored;
			try {
				stored = await this.assetStore.put(assetKey, generated.bytes, generated.contentType);
			} catch {
				const cleanupSucceeded = await deleteAssetBestEffort(this.assetStore, assetKey);
				throw new ImageProviderError(
					'The generated image could not be copied to durable storage.',
					'ASSET_STORAGE_FAILED',
					generated.providerRequestId,
					{ ...generated.metadata, cleanupSucceeded },
				);
			}
			let recorded = false;
			try {
				recorded = await this.imageRepository.recordGenerated({
					id,
					storyId,
					provider: generated.provider,
					model: generated.model,
					prompt: prompt.prompt,
					promptVersion: prompt.promptVersion,
					aspectRatio,
					providerRequestId: generated.providerRequestId,
					assetKey: stored.key,
					contentType: stored.contentType,
					byteSize: stored.byteSize,
					altText: prompt.proposedAltText,
					metadata: generated.metadata,
					requestedByEmail,
					requestedAt,
					generatedAt: generated.generatedAt,
					auditId: this.createId(),
				});
			} catch (error) {
				await deleteAssetBestEffort(this.assetStore, stored.key);
				throw error;
			}
			if (!recorded) {
				await deleteAssetBestEffort(this.assetStore, stored.key);
				throw new EditorialValidationError('The story changed; the generated asset was not attached.', 'conflict');
			}
			return { imageId: id, status: 'GENERATED' };
		} catch (error) {
			if (error instanceof ImageProviderError) {
				await this.imageRepository.recordFailure({
					id,
					storyId,
					provider: this.provider.provider,
					model: this.provider.model,
					prompt: prompt.prompt,
					promptVersion: prompt.promptVersion,
					aspectRatio,
					providerRequestId: error.providerRequestId ?? providerRequestId,
					metadata: Object.keys(error.metadata).length ? error.metadata : providerMetadata,
					errorClassification: error.failureClassification,
					errorMessage: error.message.slice(0, 500),
					requestedByEmail,
					requestedAt,
					auditId: this.createId(),
				});
			}
			throw error;
		}
	}

	async resolveStalePending(
		identity: EditorialIdentity,
		input: { storyId: unknown; imageId: unknown },
	): Promise<'GENERATED' | 'GENERATION_FAILED'> {
		actor(identity);
		const storyId = requiredText(input.storyId, 'Story ID', 100);
		const imageId = requiredText(input.imageId, 'Image ID', 100);
		const story = await this.editorialRepository.findEditorialStoryById(storyId);
		if (!story) throw new EditorialValidationError('The story was not found.', 'not-found');
		const image = await this.imageRepository.findById(imageId);
		if (!image || image.storyId !== storyId || image.status !== 'PENDING') {
			throw new EditorialValidationError('The image request is not pending.', 'conflict');
		}
		const resolvedAt = this.now();
		const requestedAtMs = Date.parse(image.requestedAt);
		const resolvedAtMs = Date.parse(resolvedAt);
		if (!Number.isFinite(requestedAtMs) || !Number.isFinite(resolvedAtMs)
			|| resolvedAtMs - requestedAtMs < STALE_PENDING_MINIMUM_MS) {
			throw new EditorialValidationError('A pending image can be resolved manually only after one hour.', 'conflict');
		}

		const callback = await this.imageRepository.findWebhook(imageId);
		if (callback) {
			if (image.providerRequestId && image.providerRequestId !== callback.providerRequestId) {
				throw new EditorialValidationError('The pending image has conflicting provider provenance.', 'conflict');
			}
			if (callback.processingState !== 'PROCESSING') {
				if (!this.processStoredWebhook) {
					throw new ImageProviderError('Asynchronous image callbacks are not configured.', 'PROVIDER_CONFIGURATION');
				}
				if (!image.providerRequestId) {
					const attached = await this.imageRepository.attachSubmission({
						imageId,
						providerRequestId: callback.providerRequestId,
						metadata: { ...image.metadata, recoveredFromWebhook: true },
						submittedAt: resolvedAt,
						auditId: this.createId(),
					});
					if (!attached) throw new EditorialValidationError('The pending image changed; reload and retry.', 'conflict');
				}
				await this.processStoredWebhook(imageId);
				const completed = await this.imageRepository.findById(imageId);
				if (completed?.status === 'GENERATED' || completed?.status === 'GENERATION_FAILED') {
					return completed.status;
				}
				throw new EditorialValidationError('The pending callback could not be resolved.', 'conflict');
			}
		}

		throw new EditorialValidationError(
			'A pending image without definitive provider evidence remains protected and requires investigation.',
			'conflict',
		);
	}

	async approve(identity: EditorialIdentity, input: { storyId: unknown; imageId: unknown; altText: unknown }): Promise<void> {
		const storyId = requiredText(input.storyId, 'Story ID', 100);
		const imageId = requiredText(input.imageId, 'Image ID', 100);
		const altText = requiredText(input.altText, 'Alt text', 500);
		const story = await this.editorialRepository.findEditorialStoryById(storyId);
		if (!story || (story.status !== 'REVIEW' && story.status !== 'APPROVED')) {
			throw new EditorialValidationError('Only a story in final review can attach an image.');
		}
		const image = await this.imageRepository.findById(imageId);
		if (!image || image.storyId !== storyId || image.status !== 'GENERATED' || !image.assetKey) {
			throw new EditorialValidationError('Only a generated image for this story can be approved.');
		}
		const changed = await this.imageRepository.approve({
			imageId, storyId, altText, actorEmail: actor(identity), reviewedAt: this.now(), auditId: this.createId(),
		});
		if (!changed) throw new EditorialValidationError('The story or image changed; reload and retry.', 'conflict');
	}

	async reject(identity: EditorialIdentity, input: { storyId: unknown; imageId: unknown }): Promise<void> {
		await this.transition(identity, input, 'GENERATED', 'REJECTED');
	}

	async requestRegeneration(identity: EditorialIdentity, input: { storyId: unknown; imageId: unknown }): Promise<void> {
		const imageId = requiredText(input.imageId, 'Image ID', 100);
		const image = await this.imageRepository.findById(imageId);
		if (!image || (image.status !== 'GENERATED' && image.status !== 'REJECTED')) {
			throw new EditorialValidationError('Only an unapproved image can request regeneration.');
		}
		await this.transition(identity, input, image.status, 'REGENERATE_REQUESTED');
	}

	private async transition(
		identity: EditorialIdentity,
		input: { storyId: unknown; imageId: unknown },
		from: 'GENERATED' | 'REJECTED',
		to: 'REJECTED' | 'REGENERATE_REQUESTED',
	): Promise<void> {
		const storyId = requiredText(input.storyId, 'Story ID', 100);
		const imageId = requiredText(input.imageId, 'Image ID', 100);
		const story = await this.editorialRepository.findEditorialStoryById(storyId);
		if (!story || (story.status !== 'REVIEW' && story.status !== 'APPROVED')) {
			throw new EditorialValidationError('Image review actions require a story in final review.');
		}
		const image = await this.imageRepository.findById(imageId);
		if (!image || image.storyId !== storyId || image.status !== from) {
			throw new EditorialValidationError('The image is not available for this review action.');
		}
		const changed = await this.imageRepository.transition({
			imageId, storyId, altText: null, from, to, actorEmail: actor(identity), reviewedAt: this.now(), auditId: this.createId(),
		});
		if (!changed) throw new EditorialValidationError('The image changed; reload and retry.', 'conflict');
	}
}
