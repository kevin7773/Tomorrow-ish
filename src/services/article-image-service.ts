import type { ArticleImageRepository } from '../data/article-image-repository';
import type { EditorialRepository } from '../data/editorial-repository';
import type { EditorialIdentity } from '../domain/editorial';
import { produceArticleImagePrompt } from '../images/article-image-prompt';
import type { ImageAssetStore } from '../images/asset-store';
import { ImageProviderError, type ImageProvider } from '../images/image-provider';
import { EditorialValidationError, requiredText } from './validation';

export interface ArticleImageServiceDependencies {
	now?: () => string;
	createId?: () => string;
	createWebhookUrl?: (imageId: string) => Promise<string>;
	processStoredWebhook?: (imageId: string) => Promise<void>;
}

export interface ArticleImageGenerationResult {
	imageId: string;
	status: 'PENDING' | 'GENERATED' | 'GENERATION_FAILED';
}

export const STALE_PENDING_MINIMUM_MS = 60 * 60 * 1000;

function actor(identity: EditorialIdentity | null | undefined): string {
	if (!identity?.email) throw new EditorialValidationError('An authenticated editor is required.', 'unauthorized');
	return identity.email.toLowerCase();
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
	}

	async generate(identity: EditorialIdentity, input: { storyId: unknown }): Promise<ArticleImageGenerationResult> {
		const requestedByEmail = actor(identity);
		const storyId = requiredText(input.storyId, 'Story ID', 100);
		const story = await this.editorialRepository.findEditorialStoryById(storyId);
		if (!story) throw new EditorialValidationError('The story was not found.', 'not-found');
		if (story.status !== 'APPROVED') {
			throw new EditorialValidationError('Only an approved story can request paid image generation.');
		}
		if (await this.imageRepository.hasPendingForStory(storyId)) {
			throw new EditorialValidationError('An image generation is already pending for this story.', 'conflict');
		}

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
		const prompt = produceArticleImagePrompt(story, promptGovernance);
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
				aspectRatio: '16:9',
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
					aspectRatio: '16:9',
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
							await this.imageRepository.failPending({
								imageId: id,
								providerRequestId: submitted.providerRequestId,
								metadata: { stage: 'submission-persistence' },
								errorClassification: 'PROVIDER_REQUEST',
								errorMessage: 'The accepted provider request could not be attached locally.',
								failedAt: this.now(),
								auditId: this.createId(),
							});
							throw new EditorialValidationError('The image submission could not be attached locally.', 'conflict');
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
				if (error instanceof ImageProviderError) {
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
					const safeFailure = new ImageProviderError(
						'The asynchronous image request could not be submitted.',
						'PROVIDER_REQUEST',
						submittedRequestId,
						{ stage: submittedRequestId ? 'submission-persistence' : 'submission' },
					);
					await this.imageRepository.failPending({
						imageId: id,
						providerRequestId: submittedRequestId,
						metadata: safeFailure.metadata,
						errorClassification: safeFailure.failureClassification,
						errorMessage: safeFailure.message,
						failedAt: this.now(),
						auditId: this.createId(),
					});
					throw safeFailure;
				}
				throw error;
			}
		}

		let providerRequestId: string | null = null;
		let providerMetadata: Record<string, unknown> = {};
		try {
			const generated = await this.provider.generate({ prompt: prompt.prompt, aspectRatio: '16:9' });
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
					aspectRatio: '16:9',
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
					aspectRatio: '16:9',
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
		const actorEmail = actor(identity);
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

		const failed = await this.imageRepository.failPending({
			imageId,
			providerRequestId: image.providerRequestId ?? callback?.providerRequestId ?? null,
			actorEmail,
			metadata: { ...image.metadata, ...callback?.metadata, manualRecovery: true },
			errorClassification: 'STALE_PENDING',
			errorMessage: 'The pending image received no callback and was closed manually after one hour.',
			failedAt: resolvedAt,
			auditId: this.createId(),
		});
		if (!failed) throw new EditorialValidationError('The pending image changed; reload and retry.', 'conflict');
		if (callback) await this.imageRepository.markWebhookProcessed(imageId, callback.providerRequestId);
		return 'GENERATION_FAILED';
	}

	async approve(identity: EditorialIdentity, input: { storyId: unknown; imageId: unknown; altText: unknown }): Promise<void> {
		const storyId = requiredText(input.storyId, 'Story ID', 100);
		const imageId = requiredText(input.imageId, 'Image ID', 100);
		const altText = requiredText(input.altText, 'Alt text', 500);
		const story = await this.editorialRepository.findEditorialStoryById(storyId);
		if (!story || story.status !== 'APPROVED') {
			throw new EditorialValidationError('Only an approved story can attach an image.');
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
		if (!story || story.status !== 'APPROVED') {
			throw new EditorialValidationError('Image review actions require an approved story.');
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
