import type { APIContext } from 'astro';
import type { EditorialIdentity } from '../domain/editorial';
import { ModelProviderError } from '../ai/model-provider';
import { ImageProviderError } from '../images/image-provider';
import { EditorialValidationError } from '../services/validation';

export function formRecord(form: FormData): Record<string, unknown> {
	return Object.fromEntries(form.entries());
}

export function requireEditor(context: APIContext): EditorialIdentity {
	const editor = context.locals.editor;
	if (!editor) throw new EditorialValidationError('An authenticated editor is required.', 'unauthorized');
	return editor;
}

export function safeReturnPath(value: FormDataEntryValue | null, fallback: string): string {
	if (
		typeof value !== 'string' ||
		(value !== '/editorial' && !value.startsWith('/editorial/')) ||
		value.startsWith('//')
	) {
		return fallback;
	}
	return value;
}

export function redirectWithResult(path: string, key: 'message' | 'error', value: string): Response {
	const url = new URL(path, 'https://tomorrow-ish.news');
	url.searchParams.set(key, value);
	return new Response(null, {
		status: 303,
		headers: { Location: `${url.pathname}${url.search}` },
	});
}

export function actionErrorResponse(error: unknown, returnPath: string): Response {
	if (error instanceof ImageProviderError) {
		const code = ['PROVIDER_CONFIGURATION', 'PROVIDER_DISABLED'].includes(error.failureClassification)
			? 'image-disabled'
			: ['PROVIDER_AUTHENTICATION', 'PROVIDER_REQUEST'].includes(error.failureClassification)
				? 'image-provider-rejected'
				: 'image-provider-unavailable';
		return redirectWithResult(returnPath, 'error', code);
	}
	if (error instanceof ModelProviderError) {
		const code = ['PROVIDER_CONFIGURATION', 'PROVIDER_DISABLED'].includes(error.failureClassification)
			? 'model-disabled'
			: ['PROVIDER_AUTHENTICATION', 'PROVIDER_REQUEST'].includes(error.failureClassification)
				? 'provider-rejected'
				: 'provider-unavailable';
		return redirectWithResult(returnPath, 'error', code);
	}
	if (error instanceof EditorialValidationError) {
		const code = [
			'not-found', 'duplicate', 'conflict', 'provider-unavailable', 'provider-rejected',
			'provider-invalid-output', 'model-budget', 'model-disabled', 'operation-failed',
		].includes(error.code) ? error.code : 'invalid-request';
		return redirectWithResult(returnPath, 'error', code);
	}
	console.error('Editorial action failed', error);
	return redirectWithResult(returnPath, 'error', 'operation-failed');
}
