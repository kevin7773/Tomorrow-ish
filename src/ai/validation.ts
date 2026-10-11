import { SATIRE_SUITABILITIES } from '../domain/editorial';
import {
	ASSERTION_KINDS,
	GUARDRAIL_FLAGS,
	SOURCE_RELATIONSHIPS,
	type ArticleBodyProposal,
	type CandidateProposal,
	type NormalizationProposal,
} from '../domain/generation';
import { ModelOutputError } from './model-provider';

function record(value: unknown, field = 'output'): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ModelOutputError('Expected an object.', 'CONTRACT_VALIDATION', field);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, field = 'text'): string {
	if (typeof value !== 'string') throw new ModelOutputError('Expected text.', 'CONTRACT_VALIDATION', field);
	const normalized = value.trim();
	if (!normalized || normalized.length > maximum) {
		throw new ModelOutputError('Text is blank or exceeds its limit.', 'CONTRACT_VALIDATION', field);
	}
	return normalized;
}

function optionalText(value: unknown, maximum: number, field: string): string {
	if (typeof value !== 'string') throw new ModelOutputError('Expected text.', 'CONTRACT_VALIDATION', field);
	const normalized = value.trim();
	if (normalized.length > maximum) throw new ModelOutputError('Text exceeds its limit.', 'CONTRACT_VALIDATION', field);
	return normalized;
}

function score(value: unknown, field = 'score'): number {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5) {
		throw new ModelOutputError('Score is outside the accepted range.', 'CONTRACT_VALIDATION', field);
	}
	return value as number;
}

export function parseNormalizationProposal(value: unknown): NormalizationProposal {
	const input = record(value);
	if (!Array.isArray(input.assertions) || input.assertions.length === 0 || input.assertions.length > 30) {
		throw new ModelOutputError();
	}
	if (!Array.isArray(input.guardrailFlags)) throw new ModelOutputError();
	if (new Set(input.guardrailFlags).size !== input.guardrailFlags.length) {
		throw new ModelOutputError('Guardrail flags must be distinct.');
	}
	const proposedSuitability = input.proposedSuitability;
	if (!SATIRE_SUITABILITIES.includes(proposedSuitability as never)) throw new ModelOutputError();

	return {
		eventStatement: text(input.eventStatement, 1_000, 'eventStatement'),
		assertions: input.assertions.map((rawAssertion) => {
			const assertion = record(rawAssertion, 'assertions[]');
			if (!ASSERTION_KINDS.includes(assertion.kind as never) || !Array.isArray(assertion.sources)) {
				throw new ModelOutputError();
			}
			return {
				kind: assertion.kind as NormalizationProposal['assertions'][number]['kind'],
				statement: text(assertion.statement, 2_000, 'assertions[].statement'),
				sources: assertion.sources.map((rawSource) => {
					const source = record(rawSource, 'assertions[].sources[]');
					if (!SOURCE_RELATIONSHIPS.includes(source.relationship as never)) throw new ModelOutputError();
					return {
						sourceReferenceId: text(source.sourceReferenceId, 100, 'assertions[].sources[].sourceReferenceId'),
						relationship: source.relationship as NormalizationProposal['assertions'][number]['sources'][number]['relationship'],
					};
				}),
			};
		}),
		proposedSignificanceScore: score(input.proposedSignificanceScore, 'proposedSignificanceScore'),
		proposedSatirePotentialScore: score(input.proposedSatirePotentialScore, 'proposedSatirePotentialScore'),
		proposedSuitability: proposedSuitability as NormalizationProposal['proposedSuitability'],
		suitabilityReason: text(input.suitabilityReason, 2_000, 'suitabilityReason'),
		guardrailFlags: input.guardrailFlags.map((flag) => {
			if (!GUARDRAIL_FLAGS.includes(flag as never)) throw new ModelOutputError();
			return flag as NormalizationProposal['guardrailFlags'][number];
		}),
	};
}

export function parseCandidateBatch(value: unknown, expectedCount = 5): CandidateProposal[] {
	if (!Array.isArray(value) || value.length !== expectedCount) {
		throw new ModelOutputError('Candidate count is invalid.', 'CONTRACT_VALIDATION', 'candidates');
	}
	const candidates = value.map((rawCandidate) => {
		const candidate = record(rawCandidate, 'candidates[]');
		return {
			headline: text(candidate.headline, 300, 'candidates[].headline'),
			deck: optionalText(candidate.deck, 1_000, 'candidates[].deck'),
			rationale: text(candidate.rationale, 2_000, 'candidates[].rationale'),
			satiricalMechanism: text(candidate.satiricalMechanism, 120, 'candidates[].satiricalMechanism'),
		};
	});
	if (new Set(candidates.map((candidate) => candidate.headline.toLowerCase())).size !== candidates.length) {
		throw new ModelOutputError('Candidate headlines must be distinct.');
	}
	return candidates;
}

function textArray(value: unknown, maximumItems: number, maximumItemLength: number, field: string): string[] {
	if (!Array.isArray(value) || value.length > maximumItems) {
		throw new ModelOutputError('Array is missing or outside its limit.', 'CONTRACT_VALIDATION', field);
	}
	return value.map((item) => text(item, maximumItemLength, `${field}[]`));
}

export function parseArticleBodyProposal(value: unknown): ArticleBodyProposal {
	const input = record(value);
	if ('factual_assertions_used' in input || 'factualAssertionsUsed' in input) {
		throw new ModelOutputError('Article-body-v1 factual provenance is not accepted by article-body-v2.');
	}
	const bodyMarkdown = text(input.body_markdown ?? input.bodyMarkdown, 20_000, 'body_markdown');
	const paragraphs = bodyMarkdown.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
	if (paragraphs.length < 4 || paragraphs.length > 7) {
		throw new ModelOutputError('Article bodies must contain four to seven paragraphs.');
	}
	if (bodyMarkdown.length < 240 || paragraphs.some((paragraph) => paragraph.length < 20)) {
		throw new ModelOutputError('Article body paragraphs must contain substantive prose.');
	}
	if (paragraphs.some((paragraph) => /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)/.test(paragraph))) {
		throw new ModelOutputError('Article bodies must be prose paragraphs, not an outline.');
	}
	if (/\b(?:lorem ipsum|placeholder text|insert (?:joke|copy|text) here|as an ai|here is (?:the|your|a) article)\b/i.test(bodyMarkdown)) {
		throw new ModelOutputError('Article body contains placeholder or meta language.');
	}
	return {
		bodyMarkdown,
		factualAssertionIdsUsed: textArray(
			input.factual_assertion_ids_used ?? input.factualAssertionIdsUsed,
			30,
			200,
			'factual_assertion_ids_used',
		),
		satireFramingSummary: text(input.satire_framing_summary ?? input.satireFramingSummary, 2_000, 'satire_framing_summary'),
		safetyNotes: textArray(input.safety_notes ?? input.safetyNotes, 20, 1_000, 'safety_notes'),
	};
}
