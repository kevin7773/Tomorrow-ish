import { describe, expect, it } from 'vitest';
import { FakeModelProvider } from '../src/ai/fake-model-provider';
import { ModelOutputError } from '../src/ai/model-provider';
import { parseCandidateBatch, parseNormalizationProposal } from '../src/ai/validation';
import {
	deterministicGuardrailFlags,
	displaySuitability,
	hasAuthoritativeFactSupport,
	mergeGuardrailFlags,
} from '../src/domain/generation';
import type { SourceReference } from '../src/domain/editorial';

const source: SourceReference = {
	id: 'source-1', sourceIntakeId: 'intake-1', sourceTitle: 'Public record',
	sourceUrl: 'https://example.com/', publisherName: 'Example', sourceTier: 'TIER_1',
	sourceType: 'PRIMARY', publishedAt: null, createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z',
};

describe('governed generation domain', () => {
	it('keeps SENSITIVE persisted while presenting it as Caution', () => {
		expect(displaySuitability('SENSITIVE')).toBe('Caution');
	});

	it('does not allow context-only corroboration to support a FACT', () => {
		expect(hasAuthoritativeFactSupport({ kind: 'FACT', sources: [{ sourceReferenceId: 'source-1', relationship: 'SUPPORTS' }] }, [{ ...source, sourceTier: 'CONTEXT_ONLY' }])).toBe(false);
		expect(hasAuthoritativeFactSupport({ kind: 'FACT', sources: [{ sourceReferenceId: 'source-1', relationship: 'SUPPORTS' }] }, [source])).toBe(true);
	});

	it('never clears deterministic guardrail flags', () => {
		const deterministic = deterministicGuardrailFlags('An alleged partisan active emergency concerns a victim.');
		expect(mergeGuardrailFlags(deterministic, [])).toEqual(expect.arrayContaining(['ACTIVE_EMERGENCY', 'IDENTIFIABLE_VICTIM', 'UNRESOLVED_ALLEGATION', 'POLITICAL_PARTISAN_FRAMING']));
	});

	it('rejects malformed normalization and candidate output', () => {
		expect(() => parseNormalizationProposal({ eventStatement: 'Incomplete' })).toThrow(ModelOutputError);
		expect(() => parseCandidateBatch([{ headline: 'Only one' }])).toThrow(ModelOutputError);
	});

	it('produces deterministic normalization and exactly five deterministic candidates without network access', async () => {
		const provider = new FakeModelProvider();
		const signal = new AbortController().signal;
		const input = { title: 'Agency Opens Drawer', neutralBrief: 'A drawer was opened.', references: [source] };
		const first = await provider.normalizeEvent(input, signal);
		const second = await provider.normalizeEvent(input, signal);
		expect(first).toEqual(second);
		expect(first.output.assertions.map((item) => item.kind)).toEqual(['FACT', 'UNCERTAINTY', 'CONTEXT']);
		expect(first.output.assertions[0].sources[0]).toEqual({ sourceReferenceId: source.id, relationship: 'SUPPORTS' });

		const candidates = await provider.generateCandidates({ eventStatement: first.output.eventStatement, facts: ['A drawer was opened.'], uncertainties: [], context: [], suitabilityReason: first.output.suitabilityReason, guardrailFlags: [], count: 5 }, signal);
		expect(candidates.output).toHaveLength(5);
		expect(new Set(candidates.output.map((item) => item.headline)).size).toBe(5);
		expect(candidates.usage.estimatedCostMicrousd).toBe(11);
	});
});
