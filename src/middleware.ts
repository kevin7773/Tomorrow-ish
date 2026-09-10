import { env } from 'cloudflare:workers';
import { defineMiddleware } from 'astro:middleware';
import { authenticateEditorialRequest, type EditorialAccessEnvironment } from './security/editorial-auth';
import {
	createCsrfToken,
	csrfCookieName,
	isValidCsrfToken,
	MutationSecurityError,
	verifySameOriginMutation,
} from './security/csrf';

function isEditorialPath(pathname: string): boolean {
	return pathname === '/editorial' || pathname.startsWith('/editorial/');
}

function forbidden(): Response {
	return new Response(
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Editorial access denied</title></head><body><main><h1>Editorial access denied</h1><p>This private newsroom requires an authorized editor.</p></main></body></html>',
		{
			status: 403,
			headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' },
		},
	);
}

export const onRequest = defineMiddleware(async (context, next) => {
	if (!isEditorialPath(context.url.pathname)) return next();

	try {
		context.locals.editor = await authenticateEditorialRequest(
			context.request,
			env as EditorialAccessEnvironment,
			{ allowLocalDevelopment: import.meta.env.DEV },
		);

		const cookieName = csrfCookieName(context.url);
		let csrfToken = context.cookies.get(cookieName)?.value;
		if (context.request.method === 'POST') {
			await verifySameOriginMutation(context.request, csrfToken);
		} else if (!isValidCsrfToken(csrfToken)) {
			csrfToken = createCsrfToken();
			context.cookies.set(cookieName, csrfToken, {
				httpOnly: true,
				secure: cookieName.startsWith('__Host-'),
				sameSite: 'strict',
				path: '/',
			});
		}
		context.locals.csrfToken = csrfToken;
	} catch (error) {
		if (error instanceof MutationSecurityError) return forbidden();
		return forbidden();
	}

	const response = await next();
	response.headers.set('Cache-Control', 'private, no-store');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set(
		'Content-Security-Policy',
		"default-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
	);
	return response;
});
