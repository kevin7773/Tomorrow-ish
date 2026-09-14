import { describe, expect, it } from 'vitest';
import {
	EDITORIAL_TIME_ZONE,
	editorialDateFromTimestamp,
	formatEditionDate,
} from '../src/lib/dates';

describe('Tomorrow-ish editorial dates', () => {
	it('keeps an evening EDT publication on the previous Eastern calendar day', () => {
		expect(editorialDateFromTimestamp('2026-09-15T01:30:00Z')).toBe('2026-09-14');
	});

	it('keeps an evening EST publication on the previous Eastern calendar day', () => {
		expect(editorialDateFromTimestamp('2026-01-13T02:30:00Z')).toBe('2026-01-12');
	});

	it('keeps an ordinary daytime publication on its Eastern calendar day', () => {
		expect(editorialDateFromTimestamp('2026-09-14T16:00:00Z')).toBe('2026-09-14');
	});

	it('uses the America/New_York DST rules across the spring transition', () => {
		expect(EDITORIAL_TIME_ZONE).toBe('America/New_York');
		expect(editorialDateFromTimestamp('2026-03-08T04:30:00Z')).toBe('2026-03-07');
		expect(editorialDateFromTimestamp('2026-03-09T03:30:00Z')).toBe('2026-03-08');
	});

	it('formats the homepage edition label from the Eastern publication day', () => {
		const editionDate = editorialDateFromTimestamp('2026-09-15T01:30:00Z');
		expect(formatEditionDate(editionDate)).toBe('Monday, September 14, 2026');
	});
});
