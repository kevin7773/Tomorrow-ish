import {
	ImageProviderError,
	type AsynchronousImageProvider,
	type ImageGenerationRequest,
	type SubmittedImageGeneration,
} from './image-provider';

const DEFAULT_API_ORIGIN = 'https://api.cloudflare.com';
const MAX_RESPONSE_CHARACTERS = 32 * 1024;

function safeIdentifier(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= 200 && /^[A-Za-z0-9._:/-]+$/.test(trimmed)
		? trimmed
		: null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function safeErrorCode(value: unknown): string | null {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
	return safeIdentifier(value);
}

async function safeErrorMetadata(response: Response): Promise<Record<string, unknown>> {
	let errorCode: string | null = null;
	try {
		const raw = await response.text();
		if (raw.length <= MAX_RESPONSE_CHARACTERS) {
			const envelope = objectValue(JSON.parse(raw));
			const firstError = Array.isArray(envelope?.errors) ? objectValue(envelope.errors[0]) : null;
			errorCode = safeErrorCode(firstError?.code);
		}
	} catch {
		// Cloudflare error bodies and parsing failures are never retained verbatim.
	}
	return {
		httpStatus: response.status,
		cloudflareRequestId: safeIdentifier(response.headers.get('cf-ray')),
		...(errorCode ? { errorCode } : {}),
	};
}

export class CloudflareGatewayImageProvider implements AsynchronousImageProvider {
	readonly provider = 'cloudflare-ai-gateway';
	readonly lifecycle = 'asynchronous' as const;

	constructor(
		private readonly accountId: string,
		private readonly apiToken: string,
		private readonly gatewayId: string,
		public readonly model: string,
		private readonly fetcher: typeof fetch = fetch,
		private readonly apiOrigin = DEFAULT_API_ORIGIN,
	) {
		if (!/^[a-f0-9]{32}$/i.test(accountId)) {
			throw new ImageProviderError('Cloudflare account configuration is invalid.', 'PROVIDER_CONFIGURATION');
		}
		if (!apiToken.trim()) {
			throw new ImageProviderError('Cloudflare AI credentials are missing.', 'PROVIDER_CONFIGURATION');
		}
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(gatewayId)) {
			throw new ImageProviderError('Cloudflare AI Gateway configuration is invalid.', 'PROVIDER_CONFIGURATION');
		}
		if (!/^openai\/gpt-image-[A-Za-z0-9.-]+$/.test(model)) {
			throw new ImageProviderError('The configured Cloudflare image model is invalid.', 'PROVIDER_CONFIGURATION');
		}
	}

	async submit(request: ImageGenerationRequest & { webhookUrl: string }): Promise<SubmittedImageGeneration> {
		if (request.aspectRatio !== '16:9') {
			throw new ImageProviderError('The requested image aspect ratio is unsupported.', 'PROVIDER_CONFIGURATION');
		}
		let webhook: URL;
		try {
			webhook = new URL(request.webhookUrl);
		} catch {
			throw new ImageProviderError('The image webhook URL is invalid.', 'PROVIDER_CONFIGURATION');
		}
		if (webhook.protocol !== 'https:') {
			throw new ImageProviderError('The image webhook URL must use HTTPS.', 'PROVIDER_CONFIGURATION');
		}

		let response: Response;
		try {
			response = await this.fetcher(`${this.apiOrigin}/client/v4/accounts/${this.accountId}/ai/run`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.apiToken}`,
					'Content-Type': 'application/json',
					'cf-aig-gateway-id': this.gatewayId,
					'cf-aig-max-attempts': '1',
					'cf-aig-collect-log-payload': 'false',
				},
				body: JSON.stringify({
					model: this.model,
					input: {
						prompt: request.prompt,
						quality: 'medium',
						size: '1536x1024',
						background: 'opaque',
						output_format: 'webp',
					},
					options: { background: true, webhookUrl: webhook.toString() },
				}),
				signal: AbortSignal.timeout(15_000),
			});
		} catch (error) {
			const name = error && typeof error === 'object' && 'name' in error
				? safeIdentifier(String(error.name))
				: null;
			throw new ImageProviderError(
				name === 'TimeoutError' || name === 'AbortError'
					? 'Cloudflare image submission timed out.'
					: 'Cloudflare AI Gateway could not be reached.',
				name === 'TimeoutError' || name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_REQUEST',
				null,
				{ stage: 'submission', exceptionName: name ?? 'UnknownError' },
			);
		}

		if (!response.ok) {
			throw new ImageProviderError(
				'Cloudflare AI Gateway rejected the image submission.',
				response.status === 401 || response.status === 403 ? 'PROVIDER_AUTHENTICATION' : 'PROVIDER_REQUEST',
				null,
				await safeErrorMetadata(response),
			);
		}

		let envelope: Record<string, unknown> | null = null;
		try {
			const raw = await response.text();
			if (raw.length === 0 || raw.length > MAX_RESPONSE_CHARACTERS) throw new Error('invalid response size');
			envelope = objectValue(JSON.parse(raw));
		} catch {
			throw new ImageProviderError('Cloudflare returned an invalid submission response.', 'PROVIDER_INVALID_OUTPUT');
		}
		if (!envelope) {
			throw new ImageProviderError('Cloudflare returned an invalid submission response.', 'PROVIDER_INVALID_OUTPUT');
		}
		const result = objectValue(envelope.result) ?? envelope;
		const providerRequestId = safeIdentifier(result.id ?? envelope.id);
		const state = safeIdentifier(result.state ?? envelope.state);
		if (!providerRequestId) {
			throw new ImageProviderError('Cloudflare returned no background run identifier.', 'PROVIDER_INVALID_OUTPUT');
		}
		return {
			provider: this.provider,
			model: this.model,
			providerRequestId,
			metadata: {
				...(state ? { submissionState: state } : {}),
				cloudflareRequestId: safeIdentifier(response.headers.get('cf-ray')),
			},
		};
	}
}
