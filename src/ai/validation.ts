import { SATIRE_SUITABILITIES } from '../domain/editorial';
import {
	ASSERTION_KINDS,
	GUARDRAIL_FLAGS,
	SOURCE_RELATIONSHIPS,
	type CandidateProposal,
	type NormalizationProposal,
} from '../domain/generation';
import { ModelOutputError } from './model-provider';

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelOutputError();
	return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number): string {
	if (typeof value !== 'string') throw new ModelOutputError();
	const normalized = value.trim();
	if (!normalized || normalized.length > maximum) throw new ModelOutputError();
	return normalized;
}

function score(value: unknown): number {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5) {
		throw new ModelOutputError();
	}
	return value as number;
}

export function parseNormalizationProposal(value: unknown): NormalizationProposal {
	const input = record(value);
	if (!Array.isArray(input.assertions) || input.assertions.length === 0 || input.assertions.length > 30) {
		throw new ModelOutputError();
	}
	if (!Array.isArray(input.guardrailFlags)) throw new ModelOutputError();
	const proposedSuitability = input.proposedSuitability;
	if (!SATIRE_SUITABILITIES.includes(proposedSuitability as never)) throw new ModelOutputError();

	return {
		eventStatement: text(input.eventStatement, 1_000),
		assertions: input.assertions.map((rawAssertion) => {
			const assertion = record(rawAssertion);
			if (!ASSERTION_KINDS.includes(assertion.kind as never) || !Array.isArray(assertion.sources)) {
				throw new ModelOutputError();
			}
			return {
				kind: assertion.kind as NormalizationProposal['assertions'][number]['kind'],
				statement: text(assertion.statement, 2_000),
				sources: assertion.sources.map((rawSource) => {
					const source = record(rawSource);
					if (!SOURCE_RELATIONSHIPS.includes(source.relationship as never)) throw new ModelOutputError();
					return {
						sourceReferenceId: text(source.sourceReferenceId, 100),
						relationship: source.relationship as NormalizationProposal['assertions'][number]['sources'][number]['relationship'],
					};
				}),
			};
		}),
		proposedSignificanceScore: score(input.proposedSignificanceScore),
		proposedSatirePotentialScore: score(input.proposedSatirePotentialScore),
		proposedSuitability: proposedSuitability as NormalizationProposal['proposedSuitability'],
		suitabilityReason: text(input.suitabilityReason, 2_000),
		guardrailFlags: input.guardrailFlags.map((flag) => {
			if (!GUARDRAIL_FLAGS.includes(flag as never)) throw new ModelOutputError();
			return flag as NormalizationProposal['guardrailFlags'][number];
		}),
	};
}

export function parseCandidateBatch(value: unknown, expectedCount = 5): CandidateProposal[] {
	if (!Array.isArray(value) || value.length !== expectedCount) throw new ModelOutputError();
	const candidates = value.map((rawCandidate) => {
		const candidate = record(rawCandidate);
		return {
			headline: text(candidate.headline, 300),
			deck: typeof candidate.deck === 'string' ? candidate.deck.trim().slice(0, 1_000) : '',
			rationale: text(candidate.rationale, 2_000),
			satiricalMechanism: text(candidate.satiricalMechanism, 120),
		};
	});
	if (new Set(candidates.map((candidate) => candidate.headline.toLowerCase())).size !== candidates.length) {
		throw new ModelOutputError('Candidate headlines must be distinct.');
	}
	return candidates;
}
