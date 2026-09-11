import type { ArticleImage, ArticleImageStatus } from '../domain/article-image';

export interface RecordGeneratedImage {
	id: string;
	storyId: string;
	provider: string;
	model: string;
	prompt: string;
	promptVersion: string;
	aspectRatio: string;
	providerRequestId: string | null;
	assetKey: string;
	contentType: string;
	byteSize: number;
	altText: string;
	metadata: Record<string, unknown>;
	requestedByEmail: string;
	requestedAt: string;
	generatedAt: string;
	auditId: string;
}

export interface RecordFailedImageGeneration {
	id: string;
	storyId: string;
	provider: string;
	model: string;
	prompt: string;
	promptVersion: string;
	aspectRatio: string;
	providerRequestId: string | null;
	metadata: Record<string, unknown>;
	errorClassification: string;
	errorMessage: string;
	requestedByEmail: string;
	requestedAt: string;
	auditId: string;
}

export interface RecordPendingImageGeneration {
	id: string;
	storyId: string;
	provider: string;
	model: string;
	prompt: string;
	promptVersion: string;
	aspectRatio: string;
	altText: string;
	requestedByEmail: string;
	requestedAt: string;
	auditId: string;
}

export interface AttachImageSubmission {
	imageId: string;
	providerRequestId: string;
	metadata: Record<string, unknown>;
	submittedAt: string;
	auditId: string;
}

export interface CompletePendingImageGeneration {
	imageId: string;
	providerRequestId: string;
	assetKey: string;
	contentType: string;
	byteSize: number;
	metadata: Record<string, unknown>;
	generatedAt: string;
	auditId: string;
}

export interface FailPendingImageGeneration {
	imageId: string;
	providerRequestId: string | null;
	actorEmail?: string;
	metadata: Record<string, unknown>;
	errorClassification: string;
	errorMessage: string;
	failedAt: string;
	auditId: string;
}

export interface ImageWebhookInboxRecord {
	imageId: string;
	providerRequestId: string;
	outcome: 'SUCCESS' | 'FAILURE';
	resultUrl: string | null;
	metadata: Record<string, unknown>;
	errorClassification: string | null;
	errorMessage: string | null;
	receivedAt: string;
	processingState: 'RECEIVED' | 'PROCESSING' | 'PROCESSED';
}

export interface ReviewImageRecord {
	imageId: string;
	storyId: string;
	actorEmail: string;
	altText: string | null;
	reviewedAt: string;
	auditId: string;
}

export interface ArticleImageRepository {
	listByStory(storyId: string): Promise<ArticleImage[]>;
	findById(id: string): Promise<ArticleImage | null>;
	findByProviderRequestId(provider: string, providerRequestId: string): Promise<ArticleImage | null>;
	hasPendingForStory(storyId: string): Promise<boolean>;
	recordGenerated(record: RecordGeneratedImage): Promise<boolean>;
	recordFailure(record: RecordFailedImageGeneration): Promise<boolean>;
	recordPending(record: RecordPendingImageGeneration): Promise<boolean>;
	attachSubmission(record: AttachImageSubmission): Promise<boolean>;
	completePending(record: CompletePendingImageGeneration): Promise<boolean>;
	failPending(record: FailPendingImageGeneration): Promise<boolean>;
	recordWebhook(record: Omit<ImageWebhookInboxRecord, 'processingState'>): Promise<'created' | 'duplicate' | 'conflict'>;
	findWebhook(imageId: string): Promise<ImageWebhookInboxRecord | null>;
	claimWebhook(imageId: string, providerRequestId: string): Promise<boolean>;
	releaseWebhook(imageId: string, providerRequestId: string): Promise<void>;
	markWebhookProcessed(imageId: string, providerRequestId: string): Promise<void>;
	approve(record: ReviewImageRecord): Promise<boolean>;
	transition(record: ReviewImageRecord & { from: ArticleImageStatus; to: ArticleImageStatus }): Promise<boolean>;
}
