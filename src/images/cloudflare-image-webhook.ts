import { ImageProviderError } from './image-provider';

export const MAX_CLOUDFLARE_WEBHOOK_BODY_CHARACTERS = 64 * 1024;

export interface CloudflareImageWebhook {
	providerRequestId: string;
	outcome: 'SUCCESS' | 'FAILURE';
	resultUrl: string | null;
	metadata: Record<string, unknown>;
	errorClassification: string | null;
	errorMessage: string | null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function safeIdentifier(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= 200 && /^[A-Za-z0-9._:/-]+$/.test(trimmed)
		? trimmed
		: null;
}

function safeUsage(value: unknown): Record<string, number> | null {
	const usage = objectValue(value);
	if (!usage) return null;
	const safe: Record<string, number> = {};
	for (const [key, entry] of Object.entries(usage)) {
		if (/^[A-Za-z0-9_]{1,50}$/.test(key) && typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) {
			safe[key] = entry;
		}
	}
	return Object.keys(safe).length ? safe : null;
}

function safeErrorCode(value: unknown): string | null {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
	return safeIdentifier(value);
}

export function parseCloudflareImageWebhook(value: unknown): CloudflareImageWebhook {
	const payload = objectValue(value);
	const providerRequestId = safeIdentifier(payload?.id);
	const state = safeIdentifier(payload?.state);
	if (!payload || !providerRequestId || !state) {
		throw new ImageProviderError('The Cloudflare webhook payload is malformed.', 'PROVIDER_INVALID_OUTPUT');
	}
	const normalizedState = state.toLowerCase();
	const metadata: Record<string, unknown> = { callbackState: state };
	const callbackProvider = safeIdentifier(payload.provider);
	const callbackModel = safeIdentifier(payload.model);
	const usage = safeUsage(payload.usage);
	if (callbackProvider) metadata.callbackProvider = callbackProvider;
	if (callbackModel) metadata.callbackModel = callbackModel;
	if (usage) metadata.usage = usage;

	if (normalizedState === 'completed' || normalizedState === 'succeeded' || normalizedState === 'success') {
		const result = objectValue(payload.result);
		if (typeof result?.image !== 'string' || result.image.length === 0 || result.image.length > 2_048) {
			throw new ImageProviderError('The Cloudflare webhook contains no image result.', 'PROVIDER_INVALID_OUTPUT');
		}
		return {
			providerRequestId,
			outcome: 'SUCCESS',
			resultUrl: result.image,
			metadata,
			errorClassification: null,
			errorMessage: null,
		};
	}

	if (normalizedState === 'failed' || normalizedState === 'error' || normalizedState === 'cancelled') {
		const error = objectValue(payload.error);
		const errorType = safeIdentifier(error?.type);
		const errorCode = safeErrorCode(error?.code);
		if (errorType) metadata.errorType = errorType;
		if (errorCode) metadata.errorCode = errorCode;
		return {
			providerRequestId,
			outcome: 'FAILURE',
			resultUrl: null,
			metadata,
			errorClassification: 'PROVIDER_FAILED',
			errorMessage: 'Cloudflare AI Gateway reported that image generation failed.',
		};
	}

	throw new ImageProviderError('The Cloudflare webhook state is unsupported.', 'PROVIDER_INVALID_OUTPUT');
}

export async function readCloudflareImageWebhookRequest(request: Request): Promise<CloudflareImageWebhook> {
	const declaredLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_CLOUDFLARE_WEBHOOK_BODY_CHARACTERS) {
		throw new ImageProviderError('The Cloudflare webhook payload is oversized.', 'PROVIDER_INVALID_OUTPUT');
	}
	let raw: string;
	try {
		raw = await request.text();
	} catch {
		throw new ImageProviderError('The Cloudflare webhook payload could not be read.', 'PROVIDER_INVALID_OUTPUT');
	}
	if (raw.length === 0 || raw.length > MAX_CLOUDFLARE_WEBHOOK_BODY_CHARACTERS) {
		throw new ImageProviderError('The Cloudflare webhook payload is invalid.', 'PROVIDER_INVALID_OUTPUT');
	}
	try {
		return parseCloudflareImageWebhook(JSON.parse(raw));
	} catch (error) {
		if (error instanceof ImageProviderError) throw error;
		throw new ImageProviderError('The Cloudflare webhook payload is malformed.', 'PROVIDER_INVALID_OUTPUT');
	}
}
