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
	recordGenerated(record: RecordGeneratedImage): Promise<boolean>;
	recordFailure(record: RecordFailedImageGeneration): Promise<boolean>;
	approve(record: ReviewImageRecord): Promise<boolean>;
	transition(record: ReviewImageRecord & { from: ArticleImageStatus; to: ArticleImageStatus }): Promise<boolean>;
}
