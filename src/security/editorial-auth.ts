import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { EditorialIdentity } from '../domain/editorial';

export interface EditorialAccessEnvironment {
	CF_ACCESS_TEAM_DOMAIN?: string;
	CF_ACCESS_AUD?: string;
	EDITORIAL_ALLOWED_EMAIL?: string;
}

export interface EditorialAccessConfig {
	teamDomain: string;
	audience: string;
	allowedEmail: string;
}

export class EditorialAuthenticationError extends Error {
	constructor(message = 'Editorial access denied.') {
		super(message);
		this.name = 'EditorialAuthenticationError';
	}
}

export type AccessTokenVerifier = (
	token: string,
	config: EditorialAccessConfig,
) => Promise<JWTPayload>;

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function normalizeTeamDomain(value: string): string {
	const candidate = value.includes('://') ? value : `https://${value}`;
	const url = new URL(candidate);
	if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
		throw new EditorialAuthenticationError();
	}
	return url.origin;
}

export function readEditorialAccessConfig(
	environment: EditorialAccessEnvironment,
): EditorialAccessConfig {
	const teamDomain = environment.CF_ACCESS_TEAM_DOMAIN?.trim();
	const audience = environment.CF_ACCESS_AUD?.trim();
	const allowedEmail = environment.EDITORIAL_ALLOWED_EMAIL?.trim().toLowerCase();
	if (!teamDomain || !audience || !allowedEmail) throw new EditorialAuthenticationError();
	return {
		teamDomain: normalizeTeamDomain(teamDomain),
		audience,
		allowedEmail,
	};
}

export async function verifyCloudflareAccessToken(
	token: string,
	config: EditorialAccessConfig,
): Promise<JWTPayload> {
	const keyUrl = `${config.teamDomain}/cdn-cgi/access/certs`;
	let keySet = remoteKeySets.get(keyUrl);
	if (!keySet) {
		keySet = createRemoteJWKSet(new URL(keyUrl));
		remoteKeySets.set(keyUrl, keySet);
	}
	const result = await jwtVerify(token, keySet, {
		issuer: config.teamDomain,
		audience: config.audience,
	});
	return result.payload;
}

function isLocalDevelopmentRequest(request: Request): boolean {
	const url = new URL(request.url);
	return (
		(url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
		(url.protocol === 'http:' || url.protocol === 'https:')
	);
}

export async function authenticateEditorialRequest(
	request: Request,
	environment: EditorialAccessEnvironment,
	options: {
		allowLocalDevelopment?: boolean;
		verifyToken?: AccessTokenVerifier;
	} = {},
): Promise<EditorialIdentity> {
	if (options.allowLocalDevelopment && isLocalDevelopmentRequest(request)) {
		return {
			email: environment.EDITORIAL_ALLOWED_EMAIL?.trim().toLowerCase() ||
				'newsgoblin@tomorrow-ish.news',
		};
	}

	const config = readEditorialAccessConfig(environment);
	const token = request.headers.get('Cf-Access-Jwt-Assertion')?.trim();
	if (!token) throw new EditorialAuthenticationError();

	try {
		const payload = await (options.verifyToken ?? verifyCloudflareAccessToken)(token, config);
		const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
		if (!email || email !== config.allowedEmail) throw new EditorialAuthenticationError();
		return { email };
	} catch (error) {
		if (error instanceof EditorialAuthenticationError) throw error;
		throw new EditorialAuthenticationError();
	}
}
