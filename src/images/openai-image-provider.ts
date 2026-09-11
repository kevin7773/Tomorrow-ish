import {
	ImageProviderError,
	type GeneratedImage,
	type ImageGenerationRequest,
	type SynchronousImageProvider,
} from './image-provider';

const DEFAULT_API_URL = 'https://api.openai.com/v1/images/generations';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_CHARACTERS = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64 * 1024;
const MAX_PROVIDER_ERROR_BODY_CHARACTERS = 16 * 1024;
const OUTPUT_FORMAT = 'webp';

interface OpenAIImageResponse {
	created?: unknown;
	data?: unknown;
	output_format?: unknown;
	quality?: unknown;
	size?: unknown;
	usage?: unknown;
}

function safeRequestId(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(trimmed)
		? trimmed
		: null;
}

function safeIdentifier(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(trimmed)
		? trimmed
		: null;
}

function safeHeader(value: string | null, maxLength = 100): string | null {
	if (value === null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= maxLength && /^[\x20-\x7E]+$/.test(trimmed)
		? trimmed
		: null;
}

function exceptionMetadata(error: unknown, stage: 'request-setup' | 'fetch'): Record<string, unknown> {
	const exceptionName = error && typeof error === 'object' && 'name' in error
		? safeIdentifier(String(error.name))
		: null;
	const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : null;
	const causeName = cause && typeof cause === 'object' && 'name' in cause
		? safeIdentifier(String(cause.name))
		: null;
	return {
		exceptionCategory: exceptionName === 'AbortError' || exceptionName === 'TimeoutError'
			? 'timeout'
			: stage === 'fetch' && exceptionName === 'TypeError'
				? 'network-or-fetch'
				: 'runtime',
		exceptionName: exceptionName ?? 'UnknownError',
		...(causeName ? { causeName } : {}),
		stage,
	};
}

async function providerErrorMetadata(response: Response): Promise<Record<string, unknown>> {
	let errorType: string | null = null;
	let errorCode: string | null = null;
	try {
		const raw = await response.text();
		if (raw.length <= MAX_PROVIDER_ERROR_BODY_CHARACTERS) {
			const envelope: unknown = JSON.parse(raw);
			if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
				const error = (envelope as { error?: unknown }).error;
				if (error && typeof error === 'object' && !Array.isArray(error)) {
					errorType = safeIdentifier((error as { type?: unknown }).type);
					errorCode = safeIdentifier((error as { code?: unknown }).code);
				}
			}
		}
	} catch {
		// Provider error bodies are optional and are never retained verbatim.
	}
	return {
		httpStatus: response.status,
		errorType,
		errorCode,
		retryAfter: safeHeader(response.headers.get('retry-after')),
	};
}

function sizeForAspectRatio(aspectRatio: string): string {
	switch (aspectRatio) {
		case '16:9': return '1536x864';
		case '9:16': return '864x1536';
		case '1:1': return '1024x1024';
		case '3:2': return '1536x1024';
		case '2:3': return '1024x1536';
		default:
			throw new ImageProviderError('The requested image aspect ratio is unsupported.', 'PROVIDER_CONFIGURATION');
	}
}

function safeMetadata(response: OpenAIImageResponse): Record<string, unknown> {
	const metadata: Record<string, unknown> = {};
	if (typeof response.output_format === 'string') metadata.outputFormat = response.output_format;
	if (typeof response.quality === 'string') metadata.quality = response.quality;
	if (typeof response.size === 'string') metadata.size = response.size;
	if (response.usage && typeof response.usage === 'object' && !Array.isArray(response.usage)) {
		const usage = response.usage as Record<string, unknown>;
		metadata.usage = {
			inputTokens: Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : null,
			outputTokens: Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : null,
			totalTokens: Number.isSafeInteger(usage.total_tokens) ? usage.total_tokens : null,
		};
	}
	return metadata;
}

function firstBase64Image(response: OpenAIImageResponse): string | null {
	if (!Array.isArray(response.data) || response.data.length !== 1) return null;
	const image = response.data[0];
	if (!image || typeof image !== 'object' || Array.isArray(image)) return null;
	const value = (image as { b64_json?: unknown }).b64_json;
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function generatedAt(value: unknown): string {
	if (typeof value === 'number' && Number.isFinite(value)) {
		const date = new Date(value * 1_000);
		if (!Number.isNaN(date.getTime())) return date.toISOString();
	}
	return new Date().toISOString();
}

function decodeBase64Image(value: string, requestId: string | null, metadata: Record<string, unknown>): ArrayBuffer {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
		throw new ImageProviderError('OpenAI returned invalid base64 image data.', 'PROVIDER_INVALID_OUTPUT', requestId, metadata);
	}
	const estimatedBytes = Math.floor(value.length * 3 / 4);
	if (estimatedBytes === 0 || estimatedBytes > MAX_IMAGE_BYTES) {
		throw new ImageProviderError('OpenAI returned an invalid image size.', 'PROVIDER_INVALID_OUTPUT', requestId, {
			...metadata,
			byteSize: estimatedBytes,
		});
	}

	let decoded: string;
	try {
		decoded = atob(value.padEnd(Math.ceil(value.length / 4) * 4, '='));
	} catch {
		throw new ImageProviderError('OpenAI returned invalid base64 image data.', 'PROVIDER_INVALID_OUTPUT', requestId, metadata);
	}
	if (decoded.length === 0 || decoded.length > MAX_IMAGE_BYTES) {
		throw new ImageProviderError('OpenAI returned an invalid image size.', 'PROVIDER_INVALID_OUTPUT', requestId, {
			...metadata,
			byteSize: decoded.length,
		});
	}
	const bytes = new Uint8Array(decoded.length);
	for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
	const isWebp = bytes.length >= 12
		&& String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
		&& String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
	if (!isWebp) {
		throw new ImageProviderError('OpenAI returned an unexpected image format.', 'PROVIDER_INVALID_OUTPUT', requestId, metadata);
	}
	return bytes.buffer;
}

export class OpenAIImageProvider implements SynchronousImageProvider {
	readonly provider = 'openai';
	readonly lifecycle = 'synchronous' as const;

	constructor(
		private readonly apiKey: string,
		public readonly model: string,
		private readonly fetcher: typeof fetch = fetch,
		private readonly apiUrl = DEFAULT_API_URL,
	) {
		if (!apiKey.trim()) {
			throw new ImageProviderError('OpenAI API credentials are missing.', 'PROVIDER_CONFIGURATION');
		}
		if (!/^gpt-image-[A-Za-z0-9.-]+$/.test(model)) {
			throw new ImageProviderError('The configured OpenAI image model is invalid.', 'PROVIDER_CONFIGURATION');
		}
	}

	async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
		const size = sizeForAspectRatio(request.aspectRatio);
		let init: RequestInit;
		try {
			init = {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: this.model,
					prompt: request.prompt,
					n: 1,
					size,
					quality: 'high',
					background: 'opaque',
					moderation: 'auto',
					output_format: OUTPUT_FORMAT,
					output_compression: 90,
				}),
				signal: AbortSignal.timeout(120_000),
			};
		} catch (error) {
			throw new ImageProviderError(
				'OpenAI image request setup failed.',
				'PROVIDER_REQUEST',
				null,
				exceptionMetadata(error, 'request-setup'),
			);
		}

		let response: Response;
		try {
			response = await this.fetcher(this.apiUrl, init);
		} catch (error) {
			if (error instanceof ImageProviderError) throw error;
			const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
			throw new ImageProviderError(
				name === 'TimeoutError' || name === 'AbortError' ? 'OpenAI image generation timed out.' : 'OpenAI could not be reached.',
				name === 'TimeoutError' || name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_REQUEST',
				null,
				exceptionMetadata(error, 'fetch'),
			);
		}

		const requestId = safeRequestId(response.headers.get('x-request-id'));
		if (!response.ok) {
			const classification = response.status === 401 || response.status === 403
				? 'PROVIDER_AUTHENTICATION'
				: 'PROVIDER_REQUEST';
			throw new ImageProviderError(
				'OpenAI rejected the image request.',
				classification,
				requestId,
				await providerErrorMetadata(response),
			);
		}
		const declaredLength = Number(response.headers.get('content-length'));
		if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_CHARACTERS) {
			throw new ImageProviderError('OpenAI returned an oversized response.', 'PROVIDER_INVALID_OUTPUT', requestId);
		}

		let raw: string;
		try {
			raw = await response.text();
		} catch {
			throw new ImageProviderError('OpenAI returned an unreadable response.', 'PROVIDER_INVALID_OUTPUT', requestId);
		}
		if (raw.length === 0 || raw.length > MAX_RESPONSE_CHARACTERS) {
			throw new ImageProviderError('OpenAI returned an invalid response size.', 'PROVIDER_INVALID_OUTPUT', requestId);
		}

		let result: OpenAIImageResponse;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid response');
			result = parsed as OpenAIImageResponse;
		} catch {
			throw new ImageProviderError('OpenAI returned a non-JSON response.', 'PROVIDER_INVALID_OUTPUT', requestId);
		}
		const metadata = safeMetadata(result);
		if (result.output_format !== undefined && result.output_format !== OUTPUT_FORMAT) {
			throw new ImageProviderError('OpenAI returned an unexpected image format.', 'PROVIDER_INVALID_OUTPUT', requestId, metadata);
		}
		const base64 = firstBase64Image(result);
		if (!base64) {
			throw new ImageProviderError('OpenAI returned no image asset.', 'PROVIDER_INVALID_OUTPUT', requestId, metadata);
		}
		const bytes = decodeBase64Image(base64, requestId, metadata);
		return {
			provider: this.provider,
			model: this.model,
			providerRequestId: requestId,
			bytes,
			contentType: 'image/webp',
			fileExtension: 'webp',
			generatedAt: generatedAt(result.created),
			metadata,
		};
	}
}
