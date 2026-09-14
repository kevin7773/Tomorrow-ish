import type { ModelOperation, ModelResult } from '../domain/generation';
import { ModelProviderError } from './model-provider';

export const NORMALIZATION_PROMPT_VERSION = 'normalize-v1';
export const CANDIDATE_PROMPT_VERSION = 'candidates-v1';
export const ARTICLE_BODY_PROMPT_VERSION = 'article-body-v2';

export const HOUSE_VOICE_CONTRACT = [
	'Dry, calm, and institutional.',
	'Plausible for approximately half a second, then increasingly absurd through specifics.',
	'No meme-speak, outrage voice, partisan advocacy, generic joke templates, or needless punchline stacking.',
	'Target behavior, contradictions, bureaucracy, incentives, rhetoric, institutional absurdity, and systems.',
	'Never turn an invented satirical detail into a factual assertion.',
].join(' ');

export interface ModelLimits {
	timeoutMs: number;
	candidateTimeoutMs: number;
	maxAttempts: number;
	defaultCandidateCount: number;
	maxInputCharacters: number;
	maxOutputCharacters: number;
	maxEstimatedCostMicrousd: number;
}

export const DEFAULT_MODEL_LIMITS: Readonly<ModelLimits> = {
	timeoutMs: 8_000,
	candidateTimeoutMs: 25_000,
	maxAttempts: 2,
	defaultCandidateCount: 5,
	maxInputCharacters: 24_000,
	maxOutputCharacters: 24_000,
	maxEstimatedCostMicrousd: 100_000,
};

export function modelLimitsForOperation(
	operation: ModelOperation,
	limits: Readonly<ModelLimits> = DEFAULT_MODEL_LIMITS,
): Readonly<ModelLimits> {
	if (operation === 'GENERATE_CANDIDATES') return { ...limits, timeoutMs: limits.candidateTimeoutMs };
	if (operation === 'GENERATE_ARTICLE_BODY') {
		return { ...limits, timeoutMs: limits.candidateTimeoutMs, maxAttempts: 1 };
	}
	return limits;
}

export class ModelLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ModelLimitError';
	}
}

export class ModelExecutionError extends Error {
	constructor(message: string, readonly retryCount: number, readonly latencyMs: number, readonly cause: unknown) {
		super(message);
		this.name = 'ModelExecutionError';
	}
}

export async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function runWithLimits<T>(
	operation: (signal: AbortSignal) => Promise<ModelResult<T>>,
	inputCharacters: number,
	limits: Readonly<ModelLimits> = DEFAULT_MODEL_LIMITS,
): Promise<{ result: ModelResult<T>; retryCount: number; latencyMs: number }> {
	if (inputCharacters > limits.maxInputCharacters) throw new ModelLimitError('Model input is too large.');
	const started = performance.now();
	let finalError: unknown;
	for (let attempt = 0; attempt < limits.maxAttempts; attempt += 1) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
		try {
			const result = await operation(controller.signal);
			if (result.usage.outputCharacters > limits.maxOutputCharacters) {
				throw new ModelLimitError('Model output is too large.');
			}
			if (result.usage.estimatedCostMicrousd > limits.maxEstimatedCostMicrousd) {
				throw new ModelLimitError('Model run exceeded its configured cost limit.');
			}
			return { result, retryCount: attempt, latencyMs: Math.round(performance.now() - started) };
		} catch (error) {
			finalError = error;
			if (error instanceof ModelLimitError) throw error;
			if (error instanceof ModelProviderError && !error.retryable) {
				throw new ModelExecutionError(error.message, attempt, Math.round(performance.now() - started), error);
			}
		} finally {
			clearTimeout(timeout);
		}
	}
	throw new ModelExecutionError(
		finalError instanceof Error ? finalError.message : 'Model operation failed.',
		Math.max(0, limits.maxAttempts - 1),
		Math.round(performance.now() - started),
		finalError,
	);
}
