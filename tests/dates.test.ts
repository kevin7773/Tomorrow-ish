import { describe, expect, it } from 'vitest';
import {
	EDITORIAL_TIME_ZONE,
	editorialDateFromTimestamp,
	editorialOperatingWindow,
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

	it('returns exact 23-hour and 25-hour New York budget windows', () => {
		expect(editorialOperatingWindow('2026-03-08T16:00:00Z')).toEqual({
			operatingDate: '2026-03-08', start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z',
		});
		expect(editorialOperatingWindow('2026-11-01T17:00:00Z')).toEqual({
			operatingDate: '2026-11-01', start: '2026-11-01T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z',
		});
	});

	it('formats the homepage edition label from the Eastern publication day', () => {
		const editionDate = editorialDateFromTimestamp('2026-09-15T01:30:00Z');
		expect(formatEditionDate(editionDate)).toBe('Monday, September 14, 2026');
	});
});
