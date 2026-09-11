import {
	ImageProviderError,
	type GeneratedImage,
	type ImageGenerationRequest,
	type ImageProvider,
} from './image-provider';

const DEFAULT_API_BASE_URL = 'https://api.replicate.com/v1';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(['image/webp', 'image/png', 'image/jpeg']);

interface ReplicatePrediction {
	id?: unknown;
	model?: unknown;
	version?: unknown;
	status?: unknown;
	output?: unknown;
	error?: unknown;
	created_at?: unknown;
	completed_at?: unknown;
	metrics?: unknown;
}

function safeMetadata(prediction: ReplicatePrediction): Record<string, unknown> {
	return {
		status: prediction.status ?? null,
		version: prediction.version ?? null,
		createdAt: prediction.created_at ?? null,
		completedAt: prediction.completed_at ?? null,
		metrics: prediction.metrics ?? null,
	};
}

function outputUrl(output: unknown): string | null {
	if (typeof output === 'string') return output;
	if (Array.isArray(output) && typeof output[0] === 'string') return output[0];
	return null;
}

function fileExtension(contentType: string): string {
	if (contentType.includes('png')) return 'png';
	if (contentType.includes('jpeg')) return 'jpg';
	return 'webp';
}

export class ReplicateFluxProvider implements ImageProvider {
	readonly provider = 'replicate';

	constructor(
		private readonly apiToken: string,
		public readonly model: string,
		private readonly fetcher: typeof fetch = fetch,
		private readonly apiBaseUrl = DEFAULT_API_BASE_URL,
	) {
		if (!apiToken.trim()) {
			throw new ImageProviderError('Replicate API token is not configured.', 'PROVIDER_CONFIGURATION');
		}
		if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*$/i.test(model)) {
			throw new ImageProviderError('The Replicate model must be an official owner/model identifier.', 'PROVIDER_CONFIGURATION');
		}
	}

	async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
		let response: Response;
		try {
			response = await this.fetcher(`${this.apiBaseUrl}/models/${this.model}/predictions`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.apiToken}`,
					'Content-Type': 'application/json',
					Prefer: 'wait=60',
					'Cancel-After': '60s',
				},
				body: JSON.stringify({
					input: {
						prompt: request.prompt,
						aspect_ratio: request.aspectRatio,
						output_format: 'webp',
						output_quality: 90,
						safety_tolerance: 2,
						...request.options,
					},
				}),
			});
		} catch {
			throw new ImageProviderError('Replicate could not be reached.', 'PROVIDER_REQUEST');
		}

		let prediction: ReplicatePrediction;
		try {
			prediction = await response.json() as ReplicatePrediction;
		} catch {
			throw new ImageProviderError('Replicate returned a non-JSON response.', 'PROVIDER_INVALID_OUTPUT');
		}
		const requestId = typeof prediction.id === 'string' ? prediction.id : null;
		if (!response.ok) {
			const classification = response.status === 401 || response.status === 403
				? 'PROVIDER_AUTHENTICATION'
				: 'PROVIDER_REQUEST';
			throw new ImageProviderError('Replicate rejected the image request.', classification, requestId, {
				...safeMetadata(prediction),
				httpStatus: response.status,
			});
		}
		const url = outputUrl(prediction.output);
		const filesReady = prediction.status === 'succeeded'
			|| (prediction.status === 'processing' && url !== null);
		if (!filesReady) {
			const classification = prediction.status === 'starting' || prediction.status === 'processing'
				? 'PROVIDER_TIMEOUT'
				: 'PROVIDER_FAILED';
			throw new ImageProviderError('Replicate did not complete the image request successfully.', classification, requestId, safeMetadata(prediction));
		}

		if (!url) {
			throw new ImageProviderError('Replicate returned no image asset.', 'PROVIDER_INVALID_OUTPUT', requestId, safeMetadata(prediction));
		}
		let assetResponse: Response;
		try {
			assetResponse = await this.fetcher(url);
		} catch {
			throw new ImageProviderError('The Replicate image asset could not be downloaded.', 'PROVIDER_REQUEST', requestId, safeMetadata(prediction));
		}
		const contentType = assetResponse.headers.get('content-type')?.split(';')[0].trim() ?? '';
		const declaredLength = Number(assetResponse.headers.get('content-length'));
		if (!assetResponse.ok || !ACCEPTED_IMAGE_TYPES.has(contentType)) {
			throw new ImageProviderError('Replicate returned an unreadable image asset.', 'PROVIDER_INVALID_OUTPUT', requestId, safeMetadata(prediction));
		}
		if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
			throw new ImageProviderError('Replicate returned an invalid image size.', 'PROVIDER_INVALID_OUTPUT', requestId, {
				...safeMetadata(prediction),
				byteSize: declaredLength,
			});
		}
		const bytes = await assetResponse.arrayBuffer();
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
			throw new ImageProviderError('Replicate returned an invalid image size.', 'PROVIDER_INVALID_OUTPUT', requestId, {
				...safeMetadata(prediction),
				byteSize: bytes.byteLength,
			});
		}

		return {
			provider: this.provider,
			model: typeof prediction.model === 'string' ? prediction.model : this.model,
			providerRequestId: requestId,
			bytes,
			contentType,
			fileExtension: fileExtension(contentType),
			generatedAt: typeof prediction.completed_at === 'string' ? prediction.completed_at : new Date().toISOString(),
			metadata: safeMetadata(prediction),
		};
	}
}
