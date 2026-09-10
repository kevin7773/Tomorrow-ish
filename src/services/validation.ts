export class EditorialValidationError extends Error {
	constructor(
		message: string,
		readonly code = 'invalid-request',
	) {
		super(message);
		this.name = 'EditorialValidationError';
	}
}

export function requiredText(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== 'string') throw new EditorialValidationError(`${label} is required.`);
	const normalized = value.trim();
	if (!normalized) throw new EditorialValidationError(`${label} is required.`);
	if (normalized.length > maxLength) {
		throw new EditorialValidationError(`${label} must be ${maxLength} characters or fewer.`);
	}
	return normalized;
}

export function optionalText(value: unknown, label: string, maxLength: number): string {
	if (value === null || value === undefined) return '';
	if (typeof value !== 'string') throw new EditorialValidationError(`${label} is invalid.`);
	const normalized = value.trim();
	if (normalized.length > maxLength) {
		throw new EditorialValidationError(`${label} must be ${maxLength} characters or fewer.`);
	}
	return normalized;
}

export function score(value: unknown, label: string): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
		throw new EditorialValidationError(`${label} must be an integer from 1 to 5.`);
	}
	return parsed;
}

export function optionalTimestamp(value: unknown, label: string): string | null {
	if (value === null || value === undefined || value === '') return null;
	const normalized = requiredText(value, label, 40);
	const parsed = new Date(normalized);
	if (Number.isNaN(parsed.valueOf())) {
		throw new EditorialValidationError(`${label} must be a valid date and time.`);
	}
	return parsed.toISOString();
}

export function editionDate(value: unknown): string {
	const normalized = requiredText(value, 'Edition date', 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
		throw new EditorialValidationError('Edition date must use YYYY-MM-DD.');
	}
	const parsed = new Date(`${normalized}T00:00:00Z`);
	if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== normalized) {
		throw new EditorialValidationError('Edition date must be a real calendar date.');
	}
	return normalized;
}

export function storySlug(value: unknown): string {
	const normalized = requiredText(value, 'Slug', 120).toLowerCase();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
		throw new EditorialValidationError(
			'Slug may contain lowercase letters, numbers, and single hyphens.',
		);
	}
	return normalized;
}

export function sourceUrl(value: unknown): string {
	const normalized = requiredText(value, 'Source URL', 2_048);
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new EditorialValidationError('Source URL must be a valid URL.');
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new EditorialValidationError('Source URL must use HTTP or HTTPS.');
	}
	return parsed.toString();
}

export function tagList(value: unknown): string[] {
	if (value === null || value === undefined || value === '') return [];
	if (typeof value !== 'string') throw new EditorialValidationError('Tags are invalid.');
	const tags = Array.from(
		new Set(
			value
				.split(',')
				.map((tag) => tag.trim().toLowerCase())
				.filter(Boolean),
		),
	);
	if (tags.length > 20 || tags.some((tag) => tag.length > 40)) {
		throw new EditorialValidationError('Use no more than 20 tags of 40 characters each.');
	}
	return tags;
}
