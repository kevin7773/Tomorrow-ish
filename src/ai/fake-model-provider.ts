import type { ModelProvider, NormalizeEventInput, GenerateArticleBodyInput, GenerateCandidatesInput } from './model-provider';
import type { ArticleBodyProposal, CandidateProposal, ModelOperation, ModelResult, NormalizationProposal } from '../domain/generation';

const revision = 'fake-v1';

function usage(input: unknown, output: unknown, cost: number) {
	const inputCharacters = JSON.stringify(input).length;
	const outputCharacters = JSON.stringify(output).length;
	return {
		inputTokens: Math.ceil(inputCharacters / 4),
		outputTokens: Math.ceil(outputCharacters / 4),
		inputCharacters,
		outputCharacters,
		estimatedCostMicrousd: cost,
	};
}

export class FakeModelProvider implements ModelProvider {
	readonly providerId = 'fake';
	readonly modelId = 'tomorrow-ish-deterministic';
	estimateMaximumCostMicrousd(operation: ModelOperation): number {
		return operation === 'NORMALIZE' ? 7 : operation === 'GENERATE_ARTICLE_BODY' ? 13 : 11;
	}

	async normalizeEvent(input: NormalizeEventInput, signal: AbortSignal): Promise<ModelResult<NormalizationProposal>> {
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const primary = input.references.find((reference) => reference.sourceTier !== 'CONTEXT_ONLY');
		const context = input.references.find((reference) => reference.sourceTier === 'CONTEXT_ONLY');
		const fallback = input.references[0];
		if (!fallback) throw new Error('At least one source reference is required.');
		const factualSource = primary ?? fallback;
		const output: NormalizationProposal = {
			eventStatement: input.title,
			assertions: [
				{
					kind: primary ? 'FACT' : 'UNCERTAINTY',
					statement: input.neutralBrief,
					sources: [{
						sourceReferenceId: factualSource.id,
						relationship: primary ? 'SUPPORTS' : 'CONTEXT',
					}],
				},
				{
					kind: 'UNCERTAINTY',
					statement: primary ? 'No additional independent confirmation was supplied.' : 'The event requires authoritative corroboration.',
					sources: [{ sourceReferenceId: factualSource.id, relationship: primary ? 'SUPPORTS' : 'CONTEXT' }],
				},
				{
					kind: 'CONTEXT',
					statement: 'Context is separated from factual authority and is not treated as confirmation.',
					sources: [{ sourceReferenceId: (context ?? fallback).id, relationship: 'CONTEXT' }],
				},
			],
			proposedSignificanceScore: 1,
			proposedSatirePotentialScore: 3,
			proposedSuitability: primary ? 'SUITABLE' : 'UNREVIEWED',
			suitabilityReason: primary
				? 'The supplied fact pattern is low-harm and suitable for dry institutional extrapolation.'
				: 'Context-only material cannot independently establish the factual event.',
			guardrailFlags: [],
		};
		return { provider: 'fake', model: 'tomorrow-ish-deterministic', providerRevision: revision, output, usage: usage(input, output, 7) };
	}

	async generateCandidates(input: GenerateCandidatesInput, signal: AbortSignal): Promise<ModelResult<CandidateProposal[]>> {
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const subject = input.eventStatement.replace(/[.!?]+$/, '');
		const mechanisms = [
			['bureaucratic extrapolation', `${subject}; Review Panel Requests Cleaner Copy of Reality`],
			['institutional literalism', `${subject}, According to Form Submitted in Triplicate`],
			['technological consequence', `${subject}; Dashboard Promises to Explain It by Thursday`],
			['corporate absurdity', `${subject} Added to Premium Tier at No Additional Clarity`],
			['absurdly reasonable conclusion', `${subject}; Officials Recommend Proceeding Approximately`],
		] as const;
		const output = mechanisms.slice(0, input.count).map(([satiricalMechanism, headline], index) => ({
			headline,
			deck: `A calm institutional response expands the original event through specific consequence ${index + 1}.`,
			rationale: 'Extends the accepted facts without presenting an invented detail as source authority.',
			satiricalMechanism,
		}));
		return { provider: 'fake', model: 'tomorrow-ish-deterministic', providerRevision: revision, output, usage: usage(input, output, 11) };
	}

	async generateArticleBody(input: GenerateArticleBodyInput, signal: AbortSignal): Promise<ModelResult<ArticleBodyProposal>> {
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const factIds = input.normalizedEvent.assertions.filter((assertion) => assertion.kind === 'FACT').map((assertion) => assertion.id);
		const output: ArticleBodyProposal = {
			bodyMarkdown: [
				`${input.candidate.headline} began as a routine development and was promptly assigned a folder.`,
				`Officials reviewed the available facts with the calm precision normally reserved for a copier warranty.`,
				`The resulting process expanded into a modest institutional response with several carefully labeled consequences.`,
				`By late afternoon, the matter had been declared understandable enough to schedule another meeting.`,
			].join('\n\n'),
			factualAssertionIdsUsed: factIds.slice(0, 1),
			satireFramingSummary: input.candidate.satiricalMechanism,
			safetyNotes: input.governance.sensitive ? ['Preserve attribution and follow the editorial caution direction.'] : [],
		};
		return { provider: 'fake', model: 'tomorrow-ish-deterministic', providerRevision: revision, providerRequestId: null, output, usage: usage(input, output, 13) };
	}
}
