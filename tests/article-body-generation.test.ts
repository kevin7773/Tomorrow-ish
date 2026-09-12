import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeModelProvider } from '../src/ai/fake-model-provider';
import { ModelProviderError } from '../src/ai/model-provider';
import { parseArticleBodyProposal } from '../src/ai/validation';
import type { ArticleBodyGenerationContext, GenerationRepository } from '../src/data/generation-repository';
import type { SourceIntake } from '../src/domain/editorial';
import type { NormalizedEventVersion } from '../src/domain/generation';
import { GenerationService } from '../src/services/generation-service';
import { DEFAULT_MODEL_LIMITS } from '../src/ai/model-runner';

const identity = { email: 'editor@example.com' };
const fact = 'Deputies said they arrested a 41-year-old man after responding to a reported incident.';

const intake: SourceIntake = {
	id: 'intake-target',
	title: 'Florida man arrested for indecent exposure in Target parking lot',
	neutralBrief: 'Authorities reported an arrest after an alleged indecent-exposure incident in a retail parking lot.',
	significanceScore: 2,
	satirePotentialScore: 4,
	satireSuitability: 'SENSITIVE',
	editorialNotes: 'Keep the focus on retail policy rather than the accused person.',
	suitabilityReason: 'The source describes an arrest and unresolved allegation requiring attribution.',
	guardrailFlags: ['UNRESOLVED_ALLEGATION'],
	assessmentReviewedByEmail: identity.email,
	assessmentReviewedAt: '2026-09-12T02:26:26.812Z',
	acceptedModelRunId: 'normalize-run',
	createdByEmail: identity.email,
	updatedByEmail: identity.email,
	createdAt: '2026-09-12T02:25:28.908Z',
	updatedAt: '2026-09-12T02:26:26.812Z',
	references: [{
		id: 'source-target', sourceIntakeId: 'intake-target', sourceTitle: 'Sheriff arrest report coverage',
		sourceUrl: 'https://news.example.test/target-report', publisherName: 'Regional Newsroom',
		sourceTier: 'TIER_2', sourceType: 'LOCAL_NEWS', publishedAt: '2026-09-11T12:00:00Z',
		createdAt: '2026-09-12T02:25:28.908Z', updatedAt: '2026-09-12T02:25:28.908Z',
	}],
};

const version: NormalizedEventVersion = {
	id: 'version-target', sourceIntakeId: intake.id, parentVersionId: null, versionNumber: 1,
	reviewState: 'ACCEPTED', origin: 'MODEL', eventStatement: intake.title,
	assertions: [
		{ id: 'fact-1', kind: 'FACT', statement: fact, sources: [{ sourceReferenceId: 'source-target', relationship: 'SUPPORTS' }] },
		{ id: 'uncertainty-1', kind: 'UNCERTAINTY', statement: 'The allegation has not been adjudicated.', sources: [{ sourceReferenceId: 'source-target', relationship: 'SUPPORTS' }] },
	],
	proposedSignificanceScore: 2, proposedSatirePotentialScore: 4, proposedSuitability: 'SENSITIVE',
	suitabilityReason: intake.suitabilityReason, guardrailFlags: ['UNRESOLVED_ALLEGATION'],
	modelRunId: 'normalize-run', createdByEmail: identity.email, reviewedByEmail: identity.email,
	reviewReason: 'Suitable only with attributed allegations and retail-policy framing.',
	createdAt: '2026-09-12T02:25:38.237Z', reviewedAt: '2026-09-12T02:26:26.812Z',
};

function context(overrides: Partial<ArticleBodyGenerationContext['candidate']> = {}): ArticleBodyGenerationContext {
	return {
		candidate: {
			id: 'candidate-target', sourceIntakeId: intake.id,
			proposedHeadline: 'Local Man’s Reported Outfit Raises Questions About Whether Sneakers Are Ever Enough',
			proposedDeck: 'Authorities described an alleged incident in a Target parking lot.',
			draftBodyMarkdown: '', categoryId: 'cat-florida-probably', categoryName: 'Florida, Probably',
			editorialNotes: 'Focus satire on hypothetical retail dress-code / parking-lot policy, not on the accused person or unresolved allegations.',
			status: 'DRAFT', normalizedEventVersionId: version.id,
			rationale: 'Targets retail policy rather than the person.', satiricalMechanism: 'bureaucratic retail extrapolation',
			bodyGenerationState: 'NOT_REQUESTED', bodyGenerationRunId: null,
			...overrides,
		},
		intake,
		version,
	};
}

function repository(bodyContext: ArticleBodyGenerationContext | null = context()) {
	const claim = vi.fn(async () => true);
	const complete = vi.fn(async () => true);
	const fail = vi.fn(async () => true);
	const resolveStale = vi.fn(async () => true);
	const repo = {
		findIntakeForGeneration: vi.fn(async () => intake), getNextNormalizedVersionNumber: vi.fn(async () => 1),
		listNormalizedVersions: vi.fn(async () => []), findNormalizedVersion: vi.fn(async () => version),
		findAcceptedNormalizedVersion: vi.fn(async () => version), findModelRun: vi.fn(async () => null),
		findModelRunByIdempotencyKey: vi.fn(async () => null),
		findArticleBodyRunByIdempotencyKey: vi.fn(async () => null),
		findCandidateForBodyGeneration: vi.fn(async () => bodyContext),
		createModelRun: vi.fn(async () => undefined), sumModelRunCostSince: vi.fn(async () => 0),
		countSuccessfulGenerationRuns: vi.fn(async () => 0), categoryExists: vi.fn(async () => true),
		createNormalization: vi.fn(async () => undefined), createEditorRevision: vi.fn(async () => undefined),
		reviewNormalization: vi.fn(async () => true), supersedeNormalization: vi.fn(async () => true),
		createGeneratedCandidates: vi.fn(async () => true), countGeneratedCandidates: vi.fn(async () => 0),
		claimArticleBodyGeneration: claim, completeArticleBodyGeneration: complete,
		failArticleBodyGeneration: fail, resolveStaleArticleBodyGeneration: resolveStale,
	} as unknown as GenerationRepository;
	return { repo, claim, complete, fail, resolveStale };
}

function service(repo: GenerationRepository, provider = new FakeModelProvider(), enabled = true) {
	let id = 0;
	return new GenerationService(repo, provider, {
		generationEnabled: enabled,
		now: () => '2026-09-12T03:00:00.000Z',
		createId: () => `body-id-${++id}`,
	});
}

describe('governed article body generation', () => {
	it('claims one eligible DRAFT candidate, supplies sensitive source governance, and persists only its body', async () => {
		const original = context();
		const { repo, claim, complete, fail } = repository(original);
		const provider = new FakeModelProvider();
		const generate = vi.spyOn(provider, 'generateArticleBody');

		const runId = await service(repo, provider).generateArticleBody(identity, {
			candidateId: original.candidate.id, idempotencyKey: 'body-target-1',
		});

		expect(runId).toBe('body-id-1');
		expect(generate).toHaveBeenCalledTimes(1);
			expect(generate.mock.calls[0][0]).toMatchObject({
			source: {
				title: intake.title, neutralBrief: intake.neutralBrief, references: [{ sourceUrl: intake.references[0].sourceUrl }],
				satireSuitability: 'SENSITIVE', guardrailFlags: ['UNRESOLVED_ALLEGATION'],
			},
			candidate: {
				headline: original.candidate.proposedHeadline, category: 'Florida, Probably',
				editorialNotes: original.candidate.editorialNotes,
			},
			normalizedEvent: {
				proposedSuitability: 'SENSITIVE', guardrailFlags: ['UNRESOLVED_ALLEGATION'],
			},
			governance: {
				sensitive: true, unresolvedAllegation: true,
				editorialCautionReason: original.candidate.editorialNotes,
			},
		});
		expect(claim).toHaveBeenCalledWith(expect.objectContaining({
			id: runId, candidateId: original.candidate.id, sourceWasSensitive: true,
			cautionReason: original.candidate.editorialNotes, requestedByEmail: identity.email,
		}));
		expect(complete).toHaveBeenCalledWith(expect.objectContaining({
			candidateId: original.candidate.id,
			bodyMarkdown: expect.stringContaining('\n\n'),
			run: expect.objectContaining({ operation: 'GENERATE_ARTICLE_BODY', status: 'SUCCEEDED', retryCount: 0 }),
		}));
		expect(fail).not.toHaveBeenCalled();
		expect(original.candidate).toMatchObject({
			status: 'DRAFT', proposedHeadline: expect.any(String), proposedDeck: expect.any(String),
			categoryId: 'cat-florida-probably', sourceIntakeId: intake.id,
		});
	});

	it.each(['REVIEW', 'APPROVED', 'REJECTED'] as const)('rejects a %s candidate before provider invocation', async (status) => {
		const { repo, claim } = repository(context({ status }));
		const provider = new FakeModelProvider();
		const generate = vi.spyOn(provider, 'generateArticleBody');
		await expect(service(repo, provider).generateArticleBody(identity, {
			candidateId: 'candidate-target', idempotencyKey: `body-${status}`,
		})).rejects.toThrow(/DRAFT/);
		expect(claim).not.toHaveBeenCalled();
		expect(generate).not.toHaveBeenCalled();
	});

	it('does not overwrite an existing body', async () => {
		const { repo, claim } = repository(context({ draftBodyMarkdown: 'A human-authored article already exists.' }));
		const provider = new FakeModelProvider();
		const generate = vi.spyOn(provider, 'generateArticleBody');
		await expect(service(repo, provider).generateArticleBody(identity, {
			candidateId: 'candidate-target', idempotencyKey: 'body-existing',
		})).rejects.toThrow(/already has/);
		expect(claim).not.toHaveBeenCalled();
		expect(generate).not.toHaveBeenCalled();
	});

	it('treats tabs and line breaks as empty consistently in service and database claims', async () => {
		const { repo, claim } = repository(context({ draftBodyMarkdown: '\t\r\n  ' }));
		await expect(service(repo).generateArticleBody(identity, {
			candidateId: 'candidate-target', idempotencyKey: 'body-whitespace',
		})).resolves.toBeTruthy();
		expect(claim).toHaveBeenCalledOnce();
		const repositorySource = readFileSync(join(process.cwd(), 'src/data/d1-generation-repository.ts'), 'utf8');
		expect(repositorySource.match(/trim\([^)]*draft_body_markdown[^,]*, char\(9\)/g)).toHaveLength(3);
	});

	it.each([
		['missing source relationship', { ...context(), intake: { ...intake, references: [] } }],
		['unaccepted normalized version', { ...context(), version: { ...version, reviewState: 'SUPERSEDED' as const } }],
	])('rejects %s before provider invocation', async (_label, invalidContext) => {
		const { repo, claim } = repository(invalidContext);
		const provider = new FakeModelProvider();
		const generate = vi.spyOn(provider, 'generateArticleBody');
		await expect(service(repo, provider).generateArticleBody(identity, {
			candidateId: 'candidate-target', idempotencyKey: `body-invalid-${_label}`,
		})).rejects.toThrow();
		expect(claim).not.toHaveBeenCalled();
		expect(generate).not.toHaveBeenCalled();
	});

	it('fails closed when newsroom model generation is disabled', async () => {
		const { repo, claim } = repository();
		const provider = new FakeModelProvider();
		const generate = vi.spyOn(provider, 'generateArticleBody');
		await expect(service(repo, provider, false).generateArticleBody(identity, {
			candidateId: 'candidate-target', idempotencyKey: 'body-disabled',
		})).rejects.toMatchObject({ code: 'model-disabled' });
		expect(claim).not.toHaveBeenCalled();
		expect(generate).not.toHaveBeenCalled();
	});

	it('prevents duplicate submission while another body run is pending', async () => {
		const { repo, claim } = repository(context({ bodyGenerationState: 'PENDING', bodyGenerationRunId: 'run-pending' }));
		const provider = new FakeModelProvider();
		const generate = vi.spyOn(provider, 'generateArticleBody');
		await expect(service(repo, provider).generateArticleBody(identity, {
			candidateId: 'candidate-target', idempotencyKey: 'body-duplicate',
		})).rejects.toMatchObject({ code: 'conflict' });
		expect(claim).not.toHaveBeenCalled();
		expect(generate).not.toHaveBeenCalled();
	});

	it('allows only one provider call when two submissions race for the database claim', async () => {
		const { repo, claim } = repository();
		claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		const provider = new FakeModelProvider();
		const generate = vi.spyOn(provider, 'generateArticleBody');
		const results = await Promise.allSettled([
			service(repo, provider).generateArticleBody(identity, { candidateId: 'candidate-target', idempotencyKey: 'body-race-1' }),
			service(repo, provider).generateArticleBody(identity, { candidateId: 'candidate-target', idempotencyKey: 'body-race-2' }),
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		expect(generate).toHaveBeenCalledTimes(1);
	});

	it('records one safe failure without changing the candidate body or retrying automatically', async () => {
		const original = context();
		const { repo, complete, fail } = repository(original);
		const provider = new FakeModelProvider();
		const generate = vi.spyOn(provider, 'generateArticleBody')
			.mockRejectedValue(new ModelProviderError('PROVIDER_NETWORK', true, undefined, {
				httpStatus: 503, errorType: 'server_error', errorCode: 'unavailable',
				errorMessage: 'A provider message that could echo sensitive input.', requestId: 'req_safe', retryAfter: null,
			}));
		await expect(service(repo, provider).generateArticleBody(identity, {
			candidateId: 'candidate-target', idempotencyKey: 'body-provider-failure',
		})).rejects.toMatchObject({ code: 'provider-unavailable' });
		expect(generate).toHaveBeenCalledTimes(1);
		expect(complete).not.toHaveBeenCalled();
		expect(fail).toHaveBeenCalledWith(expect.objectContaining({
			candidateId: 'candidate-target', failureClassification: 'PROVIDER_NETWORK',
			providerHttpStatus: 503, providerErrorType: 'server_error', providerErrorCode: 'unavailable',
			providerErrorMessage: null, providerRequestId: 'req_safe',
		}));
		expect(original.candidate.draftBodyMarkdown).toBe('');
		expect(original.candidate.status).toBe('DRAFT');
	});

	it('terminates a claim when validation fails before the provider is invoked', async () => {
		const { repo, fail } = repository();
		const provider = new FakeModelProvider();
		const generate = vi.spyOn(provider, 'generateArticleBody');
		const generation = new GenerationService(repo, provider, {
			now: () => '2026-09-12T03:00:00.000Z', createId: () => crypto.randomUUID(),
			limits: { ...DEFAULT_MODEL_LIMITS, maxInputCharacters: 1 },
		});
		await expect(generation.generateArticleBody(identity, {
			candidateId: 'candidate-target', idempotencyKey: 'body-pre-provider-failure',
		})).rejects.toMatchObject({ code: 'operation-failed' });
		expect(generate).not.toHaveBeenCalled();
		expect(fail).toHaveBeenCalledWith(expect.objectContaining({ failureClassification: 'MODEL_LIMIT' }));
	});

	it('records malformed provider output without retrying or persisting a partial body', async () => {
		const original = context();
		const { repo, complete, fail } = repository(original);
		const provider = new FakeModelProvider();
		const generate = vi.spyOn(provider, 'generateArticleBody').mockResolvedValue({
			provider: 'fake', model: 'fake', providerRevision: null, output: {} as never,
			usage: { inputTokens: 1, outputTokens: 1, inputCharacters: 1, outputCharacters: 2, estimatedCostMicrousd: 1 },
		});
		await expect(service(repo, provider).generateArticleBody(identity, {
			candidateId: 'candidate-target', idempotencyKey: 'body-malformed-output',
		})).rejects.toMatchObject({ code: 'provider-invalid-output' });
		expect(generate).toHaveBeenCalledTimes(1);
		expect(complete).not.toHaveBeenCalled();
		expect(fail).toHaveBeenCalledWith(expect.objectContaining({ failureClassification: 'MALFORMED_OUTPUT' }));
		expect(original.candidate.draftBodyMarkdown).toBe('');
	});

	it('rejects self-reported factual assertions outside the accepted source substrate', async () => {
		const original = context();
		const { repo, complete, fail } = repository(original);
		const provider = new FakeModelProvider();
		const underlying = provider.generateArticleBody.bind(provider);
		vi.spyOn(provider, 'generateArticleBody').mockImplementation(async (input, signal) => {
			const result = await underlying(input, signal);
			return { ...result, output: { ...result.output, factualAssertionsUsed: ['An unsupported factual claim.'] } };
		});
		await expect(service(repo, provider).generateArticleBody(identity, {
			candidateId: 'candidate-target', idempotencyKey: 'body-unsupported-fact',
		})).rejects.toMatchObject({ code: 'provider-invalid-output' });
		expect(complete).not.toHaveBeenCalled();
		expect(fail).toHaveBeenCalledWith(expect.objectContaining({ failureClassification: 'MALFORMED_OUTPUT' }));
		expect(original.candidate.draftBodyMarkdown).toBe('');
	});

	it('preserves a body populated by another actor during generation', async () => {
		const original = context();
		const { repo, complete, fail } = repository(original);
		vi.mocked(complete).mockImplementation(async () => original.candidate.draftBodyMarkdown.trim() === '');
		const provider = new FakeModelProvider();
		const underlying = provider.generateArticleBody.bind(provider);
		const generate = vi.spyOn(provider, 'generateArticleBody').mockImplementation(async (input, signal) => {
			original.candidate.draftBodyMarkdown = 'Human copy wins this race.';
			return underlying(input, signal);
		});
		await expect(service(repo, provider).generateArticleBody(identity, {
			candidateId: 'candidate-target', idempotencyKey: 'body-concurrent-edit',
		})).rejects.toMatchObject({ code: 'conflict' });
		expect(generate).toHaveBeenCalledTimes(1);
		expect(original.candidate.draftBodyMarkdown).toBe('Human copy wins this race.');
		expect(fail).toHaveBeenCalledWith(expect.objectContaining({ failureClassification: 'CONCURRENT_EDIT' }));
	});

	it('cannot complete after the candidate moves out of DRAFT during generation', async () => {
		const original = context();
		const { repo, complete, fail } = repository(original);
		vi.mocked(complete).mockImplementation(async () => original.candidate.status === 'DRAFT');
		const provider = new FakeModelProvider();
		const underlying = provider.generateArticleBody.bind(provider);
		vi.spyOn(provider, 'generateArticleBody').mockImplementation(async (input, signal) => {
			original.candidate.status = 'REVIEW';
			return underlying(input, signal);
		});
		await expect(service(repo, provider).generateArticleBody(identity, {
			candidateId: 'candidate-target', idempotencyKey: 'body-concurrent-status',
		})).rejects.toMatchObject({ code: 'conflict' });
		expect(original.candidate.status).toBe('REVIEW');
		expect(fail).toHaveBeenCalledWith(expect.objectContaining({ failureClassification: 'CONCURRENT_EDIT' }));
	});

	it('manually resolves a stale claim without constructing a provider call or automatic retry', async () => {
		const pending = context({ bodyGenerationState: 'PENDING', bodyGenerationRunId: 'run-stale' });
		const { repo, resolveStale } = repository(pending);
		const provider = new FakeModelProvider();
		const generate = vi.spyOn(provider, 'generateArticleBody');
		await service(repo, provider).resolveStaleArticleBodyGeneration(identity, { candidateId: 'candidate-target' });
		expect(resolveStale).toHaveBeenCalledWith(expect.objectContaining({
			runId: 'run-stale', candidateId: 'candidate-target', actorEmail: identity.email,
			staleBefore: '2026-09-12T02:00:00.000Z',
		}));
		expect(generate).not.toHaveBeenCalled();
	});

	it('rejects meta wrappers and trivial paragraphs before persistence', () => {
		const validMetadata = {
			factual_assertions_used: [fact], satire_framing_summary: 'Retail policy framing.', safety_notes: [],
		};
		expect(() => parseArticleBodyProposal({
			...validMetadata,
			body_markdown: ['Here is your article.', 'A'.repeat(80), 'B'.repeat(80), 'C'.repeat(80)].join('\n\n'),
		})).toThrow(/placeholder|meta/i);
		expect(() => parseArticleBodyProposal({
			...validMetadata,
			body_markdown: ['Tiny.', 'Small.', 'Brief.', 'Short.'].join('\n\n'),
		})).toThrow(/substantive/i);
	});

	it('keeps database claims, completion, and audit history fail-closed', () => {
		const migration = readFileSync(join(process.cwd(), 'migrations/0010_governed_article_body_generation.sql'), 'utf8');
		const repositorySource = readFileSync(join(process.cwd(), 'src/data/d1-generation-repository.ts'), 'utf8');
		expect(migration).toContain('CREATE UNIQUE INDEX idx_candidate_body_generation_pending');
		expect(migration).toContain('candidate_body_generation_runs_no_delete');
		expect(migration).toContain('candidate_body_generation_runs_provenance_immutable');
		expect(repositorySource).toContain("'ARTICLE_BODY_GENERATION_REQUESTED'");
		expect(repositorySource).toContain("'ARTICLE_BODY_GENERATED'");
		expect(repositorySource).toContain("'ARTICLE_BODY_GENERATION_FAILED'");
		expect(repositorySource).toContain("failure_classification = 'STALE_PENDING'");
		expect(repositorySource).toContain('created_at <= ?');
		expect(repositorySource).toMatch(/SET draft_body_markdown = \?, body_generation_state = 'SUCCEEDED'[\s\S]*status = 'DRAFT'[\s\S]*trim\(draft_body_markdown, char\(9\)/);
		expect(repositorySource).not.toMatch(/SET[\s\S]{0,150}proposed_headline\s*=/);
	});

	it('shows an accurate governed control without changing the existing five-alternative action', () => {
		const page = readFileSync(join(process.cwd(), 'src/pages/editorial/candidates/[id].astro'), 'utf8');
		const action = readFileSync(join(process.cwd(), 'src/pages/editorial/actions/generation.ts'), 'utf8');
		const provider = readFileSync(join(process.cwd(), 'src/ai/openai-model-provider.ts'), 'utf8');
		expect(page).toContain('Generate article body');
		expect(page).toContain('Article body generation disabled');
		expect(page).toContain("candidate.bodyGenerationState === 'PENDING'");
		expect(page).toContain('Resolve stale request');
		expect(page).toContain('hasAuthoritativeFactSupport');
		expect(action.indexOf('const identity = requireEditor(context)')).toBeLessThan(action.indexOf('getRuntimeModelConfiguration()'));
		expect(provider).toContain('Produce alternatives, not an article body.');
		expect(provider).toContain("'GENERATE_ARTICLE_BODY'");
	});
});
