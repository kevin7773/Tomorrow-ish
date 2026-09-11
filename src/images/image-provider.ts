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

export interface SubmittedImageGeneration {
	provider: string;
	model: string;
	providerRequestId: string | null;
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

interface ImageProviderBase {
	readonly provider: string;
	readonly model: string;
}

export interface SynchronousImageProvider extends ImageProviderBase {
	readonly lifecycle: 'synchronous';
	generate(request: ImageGenerationRequest): Promise<GeneratedImage>;
}

export interface AsynchronousImageProvider extends ImageProviderBase {
	readonly lifecycle: 'asynchronous';
	submit(request: ImageGenerationRequest & { webhookUrl: string }): Promise<SubmittedImageGeneration>;
}

export type ImageProvider = SynchronousImageProvider | AsynchronousImageProvider;
