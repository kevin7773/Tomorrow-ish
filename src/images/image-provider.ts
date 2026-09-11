export interface ImageGenerationRequest {
	prompt: string;
	aspectRatio: string;
	options?: Readonly<Record<string, unknown>>;
}

export interface GeneratedImage {
	provider: string;
	model: string;
	providerRequestId: string | null;
	bytes: ArrayBuffer;
	contentType: string;
	fileExtension: string;
	generatedAt: string;
	metadata: Record<string, unknown>;
}

export type ImageFailureClassification =
	| 'PROVIDER_DISABLED'
	| 'PROVIDER_CONFIGURATION'
	| 'PROVIDER_AUTHENTICATION'
	| 'PROVIDER_REQUEST'
	| 'PROVIDER_TIMEOUT'
	| 'PROVIDER_FAILED'
	| 'PROVIDER_INVALID_OUTPUT'
	| 'ASSET_STORAGE_FAILED';

export class ImageProviderError extends Error {
	constructor(
		message: string,
		public readonly failureClassification: ImageFailureClassification,
		public readonly providerRequestId: string | null = null,
		public readonly metadata: Record<string, unknown> = {},
	) {
		super(message);
		this.name = 'ImageProviderError';
	}
}

export interface ImageProvider {
	readonly provider: string;
	readonly model: string;
	generate(request: ImageGenerationRequest): Promise<GeneratedImage>;
}
