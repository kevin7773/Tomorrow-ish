export const ARTICLE_IMAGE_STATUSES = [
	'PENDING',
	'GENERATED',
	'APPROVED',
	'REJECTED',
	'REGENERATE_REQUESTED',
	'GENERATION_FAILED',
] as const;

export type ArticleImageStatus = (typeof ARTICLE_IMAGE_STATUSES)[number];

export interface ArticleImage {
	id: string;
	storyId: string;
	provider: string;
	model: string;
	prompt: string;
	aspectRatio: string;
	providerRequestId: string | null;
	assetKey: string | null;
	contentType: string | null;
	byteSize: number | null;
	status: ArticleImageStatus;
	altText: string | null;
	metadata: Record<string, unknown>;
	errorClassification: string | null;
	errorMessage: string | null;
	requestedByEmail: string;
	requestedAt: string;
	generatedAt: string | null;
	reviewedByEmail: string | null;
	reviewedAt: string | null;
}
