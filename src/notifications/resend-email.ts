import type { ReviewNotification } from './review-notifier';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const DASHBOARD_URL = 'https://tomorrow-ish.news/editorial';
const MAX_WEBHOOK_BYTES = 64 * 1024;
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface ResendEmailConfiguration {
	apiKey: string;
	webhookSigningSecret: string;
	toEmail: string;
	fromEmail: string;
}

export interface EditorialEmail {
	subject: string;
	text: string;
	html: string;
}

export interface NotificationAcceptanceTestEmailInput {
	authorizationId: string;
	idempotencyKey: string;
}

export interface ResendSubmissionResult {
	providerEmailId: string;
	responseStatus: number;
}

export type ResendWebhookType =
	| 'email.delivered'
	| 'email.delivery_delayed'
	| 'email.failed'
	| 'email.bounced'
	| 'email.suppressed';

export interface VerifiedResendWebhook {
	eventId: string;
	type: ResendWebhookType;
	providerEmailId: string;
	idempotencyHash: string;
	providerCreatedAt: string;
	recipient: string;
	payloadHash: string;
}

export class ResendConfigurationError extends Error {}

export class ResendSubmissionError extends Error {
	constructor(
		readonly classification: 'PROVIDER_REJECTED' | 'PROVIDER_AMBIGUOUS' | 'PROVIDER_INVALID_RESPONSE',
		readonly responseStatus: number | null,
		readonly diagnostics: ResendTransportDiagnostics | null = null,
	) {
		super(`Resend submission failed: ${classification}`);
	}

	get persistenceClassification(): string {
		if (!this.diagnostics) return this.classification;
		return [this.classification, this.diagnostics.failureCategory, this.diagnostics.exceptionType,
			this.diagnostics.transportStage, `${this.diagnostics.elapsedMs}MS`].join('|');
	}
}

export interface ResendTransportDiagnostics {
	failureCategory: 'FETCH_TIMEOUT' | 'FETCH_RUNTIME' | 'FETCH_NETWORK';
	exceptionType: 'AbortError' | 'TimeoutError' | 'TypeError' | 'Error' | 'UnknownError';
	transportStage: 'SUBMISSION';
	elapsedMs: number;
}

export class ResendWebhookError extends Error {
	constructor(readonly status: 400 | 401 | 413 | 415, message: string) { super(message); }
}

function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

export function validateResendConfiguration(configuration: ResendEmailConfiguration): ResendEmailConfiguration {
	const apiKey = configuration.apiKey.trim();
	const webhookSigningSecret = configuration.webhookSigningSecret.trim();
	const toEmail = normalizeEmail(configuration.toEmail);
	const fromEmail = normalizeEmail(configuration.fromEmail);
	if (!apiKey.startsWith('re_') || apiKey.length < 20) throw new ResendConfigurationError('RESEND_API_KEY is invalid.');
	if (!webhookSigningSecret.startsWith('whsec_') || webhookSigningSecret.length < 20) {
		throw new ResendConfigurationError('RESEND_WEBHOOK_SIGNING_SECRET is invalid.');
	}
	if (!/^[^\s@]+@gmail\.com$/.test(toEmail)) {
		throw new ResendConfigurationError('EDITORIAL_NOTIFICATION_TO_EMAIL must be a Gmail address.');
	}
	if (fromEmail !== 'editorial@tomorrow-ish.news') {
		throw new ResendConfigurationError('EDITORIAL_NOTIFICATION_FROM_EMAIL must be editorial@tomorrow-ish.news.');
	}
	return { apiKey, webhookSigningSecret, toEmail, fromEmail };
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function stageName(stage: ReviewNotification['stage']): string {
	return stage === 'TRIAGE' ? 'Intake triage' : 'Final editorial review';
}

export function renderEditorialEmail(notification: ReviewNotification, pendingCount: number): EditorialEmail {
	if (!Number.isInteger(pendingCount) || pendingCount < 1 || pendingCount > 3) {
		throw new ResendConfigurationError('The editorial email requires between one and three pending decisions.');
	}
	const subject = notification.kind === 'SIX_HOUR'
		? 'Tomorrow-ish: Editorial Review Reminder — 6 Hours'
		: notification.kind === 'FINAL'
			? 'Tomorrow-ish: Final Editorial Reminder — 24 Hours'
			: notification.stage === 'FINAL_REVIEW'
				? `Tomorrow-ish: ${pendingCount} Article${pendingCount === 1 ? '' : 's'} Awaiting Review`
				: `Tomorrow-ish: ${pendingCount} Intake${pendingCount === 1 ? '' : 's'} Awaiting Review`;
	const noun = notification.stage === 'TRIAGE' ? 'intake' : 'article';
	const countLine = `${pendingCount} ${noun}${pendingCount === 1 ? '' : 's'} await${pendingCount === 1 ? 's' : ''} an editorial decision.`;
	const text = [
		'Tomorrow-ish Editorial',
		'',
		countLine,
		`Stage: ${stageName(notification.stage)}`,
		`Reminder: ${notification.kind}`,
		`Batch: ${notification.batchId}`,
		'',
		`Open the protected editorial dashboard: ${DASHBOARD_URL}`,
		'',
		'This email contains no protected draft content.',
	].join('\n');
	const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;color:#172026;font-family:Arial,sans-serif">
		<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px">
		<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border:1px solid #d7d0c2;border-radius:12px">
		<tr><td style="padding:28px"><div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#7a4b2a">Tomorrow-ish Editorial</div>
		<h1 style="font-size:24px;margin:12px 0 8px">${escapeHtml(subject.replace('Tomorrow-ish: ', ''))}</h1>
		<p style="font-size:17px;line-height:1.5">${escapeHtml(countLine)}</p>
		<table role="presentation" cellspacing="0" cellpadding="4" style="font-size:14px;color:#44515a">
		<tr><td><strong>Stage</strong></td><td>${escapeHtml(stageName(notification.stage))}</td></tr>
		<tr><td><strong>Reminder</strong></td><td>${escapeHtml(notification.kind)}</td></tr>
		<tr><td><strong>Batch</strong></td><td><code>${escapeHtml(notification.batchId)}</code></td></tr></table>
		<p style="margin:24px 0"><a href="${DASHBOARD_URL}" style="background:#172026;color:#fff;text-decoration:none;padding:12px 18px;border-radius:7px;display:inline-block">Open editorial dashboard</a></p>
		<p style="font-size:12px;color:#65717a">Protected drafts and authentication information are not included in this email.</p>
		</td></tr></table></td></tr></table></body></html>`;
	return { subject, text, html };
}

export function renderNotificationAcceptanceTestEmail(
	input: NotificationAcceptanceTestEmailInput,
): EditorialEmail {
	const subject = 'Tomorrow-ish: Notification Delivery Acceptance Test';
	const text = [
		'Tomorrow-ish Editorial',
		'',
		'TEST MESSAGE — no editorial action is required.',
		'',
		'This one-time message verifies governed email submission, signed delivery confirmation, and idempotency.',
		`Acceptance authorization: ${input.authorizationId}`,
		'',
		`Protected editorial dashboard: ${DASHBOARD_URL}`,
		'',
		'This email contains no protected draft content.',
	].join('\n');
	const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;color:#172026;font-family:Arial,sans-serif">
		<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px">
		<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border:1px solid #d7d0c2;border-radius:12px">
		<tr><td style="padding:28px"><div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#7a4b2a">Tomorrow-ish Editorial</div>
		<h1 style="font-size:24px;margin:12px 0 8px">Notification delivery acceptance test</h1>
		<p style="font-size:17px;line-height:1.5"><strong>TEST MESSAGE</strong> — no editorial action is required.</p>
		<p>This one-time message verifies governed email submission, signed delivery confirmation, and idempotency.</p>
		<p style="font-size:12px;color:#65717a">Acceptance authorization: <code>${escapeHtml(input.authorizationId)}</code></p>
		<p style="font-size:12px;color:#65717a">Protected drafts and authentication information are not included in this email.</p>
		</td></tr></table></td></tr></table></body></html>`;
	return { subject, text, html };
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function editorialEmailPayloadHash(notification: ReviewNotification, pendingCount: number,
	configuration: Pick<ResendEmailConfiguration, 'toEmail' | 'fromEmail'>, email: EditorialEmail): Promise<string> {
	return sha256Hex(JSON.stringify({
		idempotencyKey: notification.idempotencyKey,
		batchId: notification.batchId,
		stage: notification.stage,
		kind: notification.kind,
		message: notification.message,
		reviewUrl: notification.reviewUrl,
		pendingCount,
		toEmail: normalizeEmail(configuration.toEmail),
		fromEmail: normalizeEmail(configuration.fromEmail),
		subject: email.subject,
		text: email.text,
		html: email.html,
	}));
}

export function notificationAcceptanceTestPayloadHash(
	input: NotificationAcceptanceTestEmailInput,
	configuration: Pick<ResendEmailConfiguration, 'toEmail' | 'fromEmail'>,
	email: EditorialEmail,
): Promise<string> {
	return sha256Hex(JSON.stringify({
		purpose: 'ACCEPTANCE_TEST',
		authorizationId: input.authorizationId,
		idempotencyKey: input.idempotencyKey,
		toEmail: normalizeEmail(configuration.toEmail),
		fromEmail: normalizeEmail(configuration.fromEmail),
		subject: email.subject,
		text: email.text,
		html: email.html,
	}));
}

function transportDiagnostics(error: unknown, elapsedMs: number): ResendTransportDiagnostics {
	const rawName = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
	const rawMessage = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
	const exceptionType: ResendTransportDiagnostics['exceptionType'] =
		rawName === 'AbortError' ? 'AbortError'
			: rawName === 'TimeoutError' ? 'TimeoutError'
				: rawName === 'TypeError' ? 'TypeError'
					: rawName === 'Error' ? 'Error' : 'UnknownError';
	const failureCategory: ResendTransportDiagnostics['failureCategory'] =
		exceptionType === 'AbortError' || exceptionType === 'TimeoutError' ? 'FETCH_TIMEOUT'
			: /illegal invocation|incorrect this reference|request context/i.test(rawMessage) ? 'FETCH_RUNTIME'
				: 'FETCH_NETWORK';
	return { failureCategory, exceptionType, transportStage: 'SUBMISSION', elapsedMs };
}

export class ResendEmailProvider {
	constructor(
		private readonly configuration: ResendEmailConfiguration,
		private readonly fetcher: typeof fetch = fetch,
		private readonly timeoutMs = 8_000,
		private readonly nowMs: () => number = () => Date.now(),
	) {}

	async submit(idempotencyKey: string, idempotencyHash: string, email: EditorialEmail): Promise<ResendSubmissionResult> {
		const configuration = validateResendConfiguration(this.configuration);
		const startedAt = this.nowMs();
		let response: Response;
		try {
			// Cloudflare's global fetch is receiver-sensitive. Detach it from this provider
			// before invocation so it is not called with the provider instance as `this`.
			const fetcher = this.fetcher;
			response = await fetcher(RESEND_EMAILS_URL, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${configuration.apiKey}`,
					'Content-Type': 'application/json',
					'Idempotency-Key': idempotencyKey,
				},
				body: JSON.stringify({
					from: configuration.fromEmail,
					to: [configuration.toEmail],
					subject: email.subject,
					text: email.text,
					html: email.html,
					tags: [{ name: 'notification_key', value: idempotencyHash }],
				}),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			throw new ResendSubmissionError('PROVIDER_AMBIGUOUS', null,
				transportDiagnostics(error, Math.max(0, Math.round(this.nowMs() - startedAt))));
		}
		if (!response.ok) {
			let providerErrorName = '';
			try {
				const errorBody = await response.json() as { name?: unknown };
				providerErrorName = typeof errorBody?.name === 'string' ? errorBody.name : '';
			} catch { /* An unreadable rejection remains classified from its HTTP status. */ }
			const outcomeMayBeUncertain = response.status >= 500 || response.status === 408
				|| (response.status === 409 && providerErrorName !== 'invalid_idempotent_request');
			throw new ResendSubmissionError(
				outcomeMayBeUncertain ? 'PROVIDER_AMBIGUOUS' : 'PROVIDER_REJECTED', response.status,
			);
		}
		let body: unknown;
		try { body = await response.json(); } catch {
			throw new ResendSubmissionError('PROVIDER_INVALID_RESPONSE', response.status);
		}
		const providerEmailId = body && typeof body === 'object' && typeof (body as { id?: unknown }).id === 'string'
			? (body as { id: string }).id.trim() : '';
		if (!/^[A-Za-z0-9_-]{8,200}$/.test(providerEmailId)) {
			throw new ResendSubmissionError('PROVIDER_INVALID_RESPONSE', response.status);
		}
		return { providerEmailId, responseStatus: response.status };
	}
}

function decodeBase64(value: string): Uint8Array {
	try {
		const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
		const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		throw new ResendWebhookError(401, 'invalid signature');
	}
}

function equalConstantTime(left: string, right: string): boolean {
	const length = Math.max(left.length, right.length);
	let difference = left.length ^ right.length;
	for (let index = 0; index < length; index += 1) {
		difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return difference === 0;
}

async function expectedWebhookSignature(secret: string, signedContent: string): Promise<string> {
	const encodedSecret = secret.startsWith('whsec_') ? secret.slice(6) : '';
	const decoded = decodeBase64(encodedSecret);
	// Svix-generated symmetric webhook secrets are 24 decoded bytes. Requiring
	// 32 bytes rejects valid provider secrets before the HMAC can be checked.
	if (decoded.byteLength < 24) throw new ResendWebhookError(401, 'invalid signing secret');
	const keyBytes = new Uint8Array(decoded.byteLength);
	keyBytes.set(decoded);
	const key = await crypto.subtle.importKey('raw', keyBytes.buffer,
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
	let binary = '';
	for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export async function readVerifiedResendWebhook(
	request: Request,
	configuration: Pick<ResendEmailConfiguration, 'webhookSigningSecret' | 'toEmail'>,
	now: () => Date = () => new Date(),
): Promise<VerifiedResendWebhook> {
	if (request.method !== 'POST') throw new ResendWebhookError(400, 'method');
	if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
		throw new ResendWebhookError(415, 'content type');
	}
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) throw new ResendWebhookError(413, 'too large');
	const raw = await request.text();
	if (!raw || new TextEncoder().encode(raw).byteLength > MAX_WEBHOOK_BYTES) throw new ResendWebhookError(413, 'too large');
	const eventId = request.headers.get('svix-id')?.trim() ?? '';
	const timestamp = request.headers.get('svix-timestamp')?.trim() ?? '';
	const supplied = request.headers.get('svix-signature')?.trim() ?? '';
	if (!/^[A-Za-z0-9_-]{8,200}$/.test(eventId) || !/^\d{10}$/.test(timestamp) || !supplied) {
		throw new ResendWebhookError(401, 'signature headers');
	}
	const age = Math.abs(Math.floor(now().getTime() / 1000) - Number(timestamp));
	if (age > WEBHOOK_TOLERANCE_SECONDS) throw new ResendWebhookError(401, 'stale signature');
	const expected = await expectedWebhookSignature(configuration.webhookSigningSecret.trim(), `${eventId}.${timestamp}.${raw}`);
	const signatures = supplied.split(/\s+/).map((part) => part.split(',', 2))
		.filter(([version, value]) => version === 'v1' && Boolean(value)).map(([, value]) => value);
	if (!signatures.some((value) => equalConstantTime(expected, value))) throw new ResendWebhookError(401, 'invalid signature');
	let payload: unknown;
	try { payload = JSON.parse(raw); } catch { throw new ResendWebhookError(400, 'invalid json'); }
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ResendWebhookError(400, 'invalid payload');
	const record = payload as Record<string, unknown>;
	const type = record.type;
	const allowed = new Set<ResendWebhookType>([
		'email.delivered', 'email.delivery_delayed', 'email.failed', 'email.bounced', 'email.suppressed',
	]);
	if (typeof type !== 'string' || !allowed.has(type as ResendWebhookType)) throw new ResendWebhookError(400, 'unsupported event');
	const data = record.data;
	if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ResendWebhookError(400, 'invalid data');
	const emailId = (data as { email_id?: unknown }).email_id;
	const recipients = (data as { to?: unknown }).to;
	const createdAt = record.created_at;
	const tags = (data as { tags?: unknown }).tags;
	const idempotencyHash = tags && typeof tags === 'object' && !Array.isArray(tags)
		&& typeof (tags as { notification_key?: unknown }).notification_key === 'string'
		? (tags as { notification_key: string }).notification_key : '';
	if (typeof emailId !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(emailId)
		|| !Array.isArray(recipients) || recipients.length !== 1 || typeof recipients[0] !== 'string'
		|| normalizeEmail(recipients[0]) !== normalizeEmail(configuration.toEmail)
		|| !/^[a-f0-9]{64}$/.test(idempotencyHash)
		|| typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
		throw new ResendWebhookError(400, 'invalid event identity');
	}
	return {
		eventId,
		type: type as ResendWebhookType,
		providerEmailId: emailId,
		idempotencyHash,
		providerCreatedAt: new Date(createdAt).toISOString(),
		recipient: normalizeEmail(recipients[0]),
		payloadHash: await sha256Hex(raw),
	};
}
