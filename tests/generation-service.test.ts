import { describe, expect, it, vi } from 'vitest';
import { FakeModelProvider } from '../src/ai/fake-model-provider';
import { ModelProviderError } from '../src/ai/model-provider';
import { OpenAIModelProvider, OPENAI_MODEL } from '../src/ai/openai-model-provider';
import type { GenerationRepository } from '../src/data/generation-repository';
import type { SourceIntake } from '../src/domain/editorial';
import type { ModelRun, NormalizedEventVersion } from '../src/domain/generation';
import { GenerationService } from '../src/services/generation-service';
import { actionErrorResponse } from '../src/lib/editorial-actions';

const identity = { email: 'editor@example.com' };
const intake: SourceIntake = {
	id: 'intake-1', title: 'Agency Opens Drawer', neutralBrief: 'A drawer was opened.',
	significanceScore: 1, satirePotentialScore: 1, satireSuitability: 'UNREVIEWED', editorialNotes: '',
	suitabilityReason: '', guardrailFlags: [], assessmentReviewedByEmail: null, assessmentReviewedAt: null,
	acceptedModelRunId: null, createdByEmail: identity.email, updatedByEmail: identity.email,
	archivedAt: null, archivedByEmail: null, archiveReason: null,
	createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z',
	references: [{ id: 'source-1', sourceIntakeId: 'intake-1', sourceTitle: 'Public record', sourceUrl: 'https://example.com/', publisherName: 'Example', sourceTier: 'TIER_1', sourceType: 'PRIMARY', publishedAt: null, createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z' }],
};

function accepted(suitability: NormalizedEventVersion['proposedSuitability'] = 'SUITABLE'): NormalizedEventVersion {
	return {
		id: 'version-1', sourceIntakeId: intake.id, parentVersionId: null, versionNumber: 1,
		reviewState: 'ACCEPTED', origin: 'MODEL', eventStatement: intake.title,
		assertions: [{ id: 'assertion-1', kind: 'FACT', statement: intake.neutralBrief, sources: [{ sourceReferenceId: 'source-1', relationship: 'SUPPORTS' }] }],
		proposedSignificanceScore: 1, proposedSatirePotentialScore: 3, proposedSuitability: suitability,
		suitabilityReason: 'Reviewed.', guardrailFlags: [], modelRunId: 'normalize-run', createdByEmail: identity.email,
		reviewedByEmail: identity.email, reviewReason: 'Accepted for testing.', createdAt: '2026-09-10T00:00:00Z', reviewedAt: '2026-09-10T00:01:00Z',
	};
}

function repository(version = accepted(), previousRuns = 0, validCategoryIds: ReadonlySet<string> | null = null) {
	let prior: ModelRun | null = null;
	const createdNormalization = vi.fn(async (record) => {
		prior = { ...record.run, normalizedEventVersionId: record.versionId } as ModelRun;
	});
	const createdCandidates = vi.fn(async (record) => {
		prior = record.run as ModelRun;
		return true;
	});
	const repo = {
		findIntakeForGeneration: vi.fn(async () => intake), getNextNormalizedVersionNumber: vi.fn(async () => 1),
		listNormalizedVersions: vi.fn(async () => []), findNormalizedVersion: vi.fn(async () => version),
		findAcceptedNormalizedVersion: vi.fn(async () => version), findModelRun: vi.fn(async () => null),
		findModelRunByIdempotencyKey: vi.fn(async () => prior), createModelRun: vi.fn(async () => undefined),
		sumModelRunCostSince: vi.fn(async () => 0),
		countSuccessfulGenerationRuns: vi.fn(async () => previousRuns),
		categoryExists: vi.fn(async (id: string) => validCategoryIds ? validCategoryIds.has(id) : true),
		createNormalization: createdNormalization, createEditorRevision: vi.fn(async () => undefined),
		reviewNormalization: vi.fn(async () => true), createGeneratedCandidates: createdCandidates,
		supersedeNormalization: vi.fn(async () => true),
		countGeneratedCandidates: vi.fn(async () => 0),
	} as unknown as GenerationRepository;
	return { repo, createdCandidates, createdNormalization };
}

describe('generation authority', () => {
	it('completes normalization with a successful injected OpenAI transport', async () => {
		const output = {
			eventStatement: 'Agency opened a drawer.',
			assertions: [
				{ kind: 'FACT', statement: 'A drawer was opened.', sources: [{ sourceReferenceId: 'source-1', relationship: 'SUPPORTS' }] },
				{ kind: 'UNCERTAINTY', statement: 'The contents were not described.', sources: [{ sourceReferenceId: 'source-1', relationship: 'SUPPORTS' }] },
				{ kind: 'CONTEXT', statement: 'Drawers store items.', sources: [{ sourceReferenceId: 'source-1', relationship: 'CONTEXT' }] },
			],
			proposedSignificanceScore: 1, proposedSatirePotentialScore: 3,
			proposedSuitability: 'SUITABLE', suitabilityReason: 'Reviewed as low harm.', guardrailFlags: [],
		};
		const transport = vi.fn(async () => new Response(JSON.stringify({
			status: 'completed', model: OPENAI_MODEL,
			output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
			usage: { input_tokens: 100, output_tokens: 50 },
		}), { status: 200 }));
		const { repo, createdNormalization } = repository();
		const service = new GenerationService(repo, new OpenAIModelProvider('test-key', OPENAI_MODEL, transport), {
			createId: (() => { let number = 0; return () => `openai-id-${++number}`; })(),
		});
		await service.proposeNormalization(identity, intake.id, 'openai-normalize-success');
		expect(createdNormalization).toHaveBeenCalledTimes(1);
		expect(createdNormalization.mock.calls[0][0].run).toMatchObject({ status: 'SUCCEEDED', provider: 'openai', model: OPENAI_MODEL });
	});

	it('never persists normalized content with duplicate provider guardrail flags', async () => {
		const output = {
			eventStatement: 'Agency opened a drawer.',
			assertions: [{ kind: 'FACT', statement: 'A drawer was opened.', sources: [{ sourceReferenceId: 'source-1', relationship: 'SUPPORTS' }] }],
			proposedSignificanceScore: 1, proposedSatirePotentialScore: 3,
			proposedSuitability: 'SUITABLE', suitabilityReason: 'Reviewed as low harm.',
			guardrailFlags: ['UNRESOLVED_ALLEGATION', 'UNRESOLVED_ALLEGATION'],
		};
		const transport = vi.fn(async () => new Response(JSON.stringify({
			status: 'completed', model: OPENAI_MODEL,
			output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
			usage: { input_tokens: 100, output_tokens: 50 },
		}), { status: 200 }));
		const { repo, createdNormalization } = repository();
		const service = new GenerationService(repo, new OpenAIModelProvider('test-key', OPENAI_MODEL, transport), {
			createId: () => 'duplicate-guardrail-run',
		});
		const caught: unknown = await service.proposeNormalization(identity, intake.id, 'duplicate-guardrail-flags').catch((error: unknown) => error);
		expect(caught).toMatchObject({ code: 'provider-invalid-output' });
		expect(createdNormalization).not.toHaveBeenCalled();
		expect(repo.createModelRun).toHaveBeenCalledWith(expect.objectContaining({
			status: 'FAILED', failureClassification: 'MALFORMED_OUTPUT', normalizedEventVersionId: null,
		}));
	});

	it('records a transport failure without creating a version or reporting invalid input', async () => {
		const transport = vi.fn(async () => { throw new TypeError('sensitive transport detail'); });
		const { repo, createdNormalization } = repository();
		const service = new GenerationService(repo, new OpenAIModelProvider('test-key', OPENAI_MODEL, transport), {
			now: () => '2026-09-11T02:21:55.828Z', createId: () => 'failed-run-id',
		});
		const caught: unknown = await service.proposeNormalization(identity, intake.id, 'openai-network-failure').catch((error: unknown) => error);
		expect(caught).toMatchObject({ code: 'provider-unavailable' });
		expect(transport).toHaveBeenCalledTimes(2);
		expect(createdNormalization).not.toHaveBeenCalled();
		expect(repo.createModelRun).toHaveBeenCalledWith(expect.objectContaining({
			id: 'failed-run-id', status: 'FAILED', failureClassification: 'PROVIDER_NETWORK', normalizedEventVersionId: null, retryCount: 1,
		}));
		const response = actionErrorResponse(caught, `/editorial/intakes/${intake.id}/normalize`);
		expect(response.headers.get('Location')).toContain('error=provider-unavailable');
		expect(response.headers.get('Location')).not.toContain('invalid-request');
	});

	it('persists only approved safe diagnostics for a rejected provider response', async () => {
		const rawBodySecret = 'raw-body-secret-must-not-persist';
		const transport = vi.fn(async () => new Response(JSON.stringify({
			error: {
				type: 'invalid_request_error', code: 'invalid_value',
				message: 'The request field is not supported.', private_detail: rawBodySecret,
			},
		}), {
			status: 400,
			headers: {
				'x-request-id': 'req_safe_456', 'retry-after': '7',
				'Authorization': 'Bearer sk-response-header-secret', 'x-private-header': 'private-header-secret',
			},
		}));
		const { repo, createdNormalization } = repository();
		const service = new GenerationService(repo, new OpenAIModelProvider('test-key', OPENAI_MODEL, transport), {
			now: () => '2026-09-11T02:32:25.216Z', createId: () => 'provider-rejected-run',
		});
		const caught: unknown = await service.proposeNormalization(identity, intake.id, 'openai-provider-rejected').catch((error: unknown) => error);
		expect(caught).toMatchObject({ code: 'provider-rejected' });
		expect(transport).toHaveBeenCalledTimes(1);
		expect(createdNormalization).not.toHaveBeenCalled();
		expect(repo.createModelRun).toHaveBeenCalledWith(expect.objectContaining({
			status: 'FAILED', failureClassification: 'PROVIDER_REQUEST', providerHttpStatus: 400,
			providerErrorType: 'invalid_request_error', providerErrorCode: 'invalid_value',
			providerErrorMessage: 'The request field is not supported.', providerRequestId: 'req_safe_456',
			providerRetryAfter: '7',
		}));
		const persisted = JSON.stringify(vi.mocked(repo.createModelRun).mock.calls[0][0]);
		expect(persisted).not.toContain(rawBodySecret);
		expect(persisted).not.toContain('sk-response-header-secret');
		expect(persisted).not.toContain('private-header-secret');
		expect(persisted).not.toContain('test-key');
	});

	it.each([
		['PROVIDER_AUTHENTICATION', 'provider-rejected'],
		['PROVIDER_REQUEST', 'provider-rejected'],
		['PROVIDER_CONFIGURATION', 'model-disabled'],
		['PROVIDER_DISABLED', 'model-disabled'],
		['PROVIDER_NETWORK', 'provider-unavailable'],
	] as const)('maps %s to the safe editorial error %s', (classification, expectedCode) => {
		const response = actionErrorResponse(new ModelProviderError(classification, false), '/editorial/intakes');
		expect(response.headers.get('Location')).toContain(`error=${expectedCode}`);
		expect(response.headers.get('Location')).not.toContain('invalid-request');
	});

	it('records a model proposal without modifying source fields and preserves deterministic flags', async () => {
		const flaggedIntake = { ...intake, title: 'Agency Reviews Alleged Filing' };
		const { repo, createdNormalization } = repository();
		vi.mocked(repo.findIntakeForGeneration).mockResolvedValue(flaggedIntake);
		const service = new GenerationService(repo, new FakeModelProvider(), { createId: (() => { let number = 0; return () => `id-${++number}`; })() });
		const first = await service.proposeNormalization(identity, intake.id, 'normalize-key');
		const second = await service.proposeNormalization(identity, intake.id, 'normalize-key');
		expect(second).toBe(first);
		expect(createdNormalization).toHaveBeenCalledTimes(1);
		const record = createdNormalization.mock.calls[0][0];
		expect(record.proposal.guardrailFlags).toContain('UNRESOLVED_ALLEGATION');
		expect(record.run.operation).toBe('NORMALIZE');
		expect(record.run.estimatedCostMicrousd).toBe(7);
		expect(flaggedIntake.neutralBrief).toBe(intake.neutralBrief);
	});

	it('records authenticated review and supersede decisions through audited repository operations', async () => {
		const { repo } = repository();
		vi.mocked(repo.findNormalizedVersion)
			.mockResolvedValueOnce({ ...accepted(), reviewState: 'PROPOSED', reviewedByEmail: null, reviewReason: null, reviewedAt: null })
			.mockResolvedValueOnce(accepted());
		const service = new GenerationService(repo, new FakeModelProvider(), { now: () => '2026-09-10T13:00:00Z', createId: () => 'audit-id' });
		await service.reviewNormalization(identity, 'version-1', 'ACCEPTED', 'Facts and suitability reviewed.');
		expect(repo.reviewNormalization).toHaveBeenCalledWith(expect.objectContaining({ actorEmail: identity.email, auditId: 'audit-id', decision: 'ACCEPTED' }));
		await service.supersedeNormalization(identity, 'version-1', 'Replaced by later reporting.');
		expect(repo.supersedeNormalization).toHaveBeenCalledWith(expect.objectContaining({ actorEmail: identity.email, auditId: 'audit-id', reason: 'Replaced by later reporting.' }));
	});

	it('creates exactly five DRAFT candidate records and makes an idempotent replay a no-op', async () => {
		const { repo, createdCandidates } = repository();
		const service = new GenerationService(repo, new FakeModelProvider(), { createId: (() => { let number = 0; return () => `id-${++number}`; })() });
		const request = { intakeId: intake.id, normalizedEventVersionId: 'version-1', categoryId: 'cat-civic-life', idempotencyKey: 'same-key' };
		const first = await service.generateCandidates(identity, request);
		const second = await service.generateCandidates(identity, request);
		expect(second).toBe(first);
		expect(createdCandidates).toHaveBeenCalledTimes(1);
		const record = createdCandidates.mock.calls[0][0];
		expect(record.candidates).toHaveLength(5);
		expect(record.run.candidateCount).toBe(5);
		expect(record.run.estimatedCostMicrousd).toBe(11);
		expect(record.run.status).toBe('SUCCEEDED');
	});

	it.each(['cat-sports', 'cat-weather', 'cat-community'])('persists generated drafts in the %s category', async (categoryId) => {
		const { repo, createdCandidates } = repository(accepted(), 0, new Set([categoryId]));
		const provider = new FakeModelProvider();
		const service = new GenerationService(repo, provider, {
			createId: (() => { let number = 0; return () => `${categoryId}-${++number}`; })(),
		});
		await service.generateCandidates(identity, {
			intakeId: intake.id,
			normalizedEventVersionId: 'version-1',
			categoryId,
			idempotencyKey: `generate-${categoryId}`,
		});
		expect(createdCandidates).toHaveBeenCalledWith(expect.objectContaining({ categoryId }));
	});

	it('rejects an unknown category before candidate provider invocation', async () => {
		const { repo, createdCandidates } = repository(accepted(), 0, new Set(['cat-sports']));
		const provider = new FakeModelProvider();
		const invoke = vi.spyOn(provider, 'generateCandidates');
		await expect(new GenerationService(repo, provider).generateCandidates(identity, {
			intakeId: intake.id,
			normalizedEventVersionId: 'version-1',
			categoryId: 'cat-unknown',
			idempotencyKey: 'unknown-category',
		})).rejects.toThrow('Category is invalid');
		expect(invoke).not.toHaveBeenCalled();
		expect(createdCandidates).not.toHaveBeenCalled();
	});

	it('records candidate timeout after two longer-timeout attempts without persisting candidates', async () => {
		const { repo, createdCandidates } = repository();
		const provider = new FakeModelProvider();
		const invoke = vi.spyOn(provider, 'generateCandidates').mockImplementation((_input, signal) => new Promise((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
		}));
		const service = new GenerationService(repo, provider, {
			createId: () => 'candidate-timeout-run',
			limits: {
				timeoutMs: 5, candidateTimeoutMs: 10, maxAttempts: 2, defaultCandidateCount: 5,
				maxInputCharacters: 24_000, maxOutputCharacters: 24_000, maxEstimatedCostMicrousd: 100_000,
			},
		});
		const caught: unknown = await service.generateCandidates(identity, {
			intakeId: intake.id, normalizedEventVersionId: 'version-1', categoryId: 'cat-civic-life', idempotencyKey: 'candidate-timeout',
		}).catch((error: unknown) => error);
		expect(caught).toMatchObject({ code: 'provider-unavailable' });
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(createdCandidates).not.toHaveBeenCalled();
		expect(repo.createModelRun).toHaveBeenCalledWith(expect.objectContaining({
			id: 'candidate-timeout-run', status: 'FAILED', failureClassification: 'TIMEOUT',
			candidateCount: 0, retryCount: 1,
		}));
	});

	it.each(['UNSUITABLE', 'UNREVIEWED'] as const)('blocks %s candidate generation', async (suitability) => {
		const { repo, createdCandidates } = repository(accepted(suitability));
		await expect(new GenerationService(repo, new FakeModelProvider()).generateCandidates(identity, { intakeId: intake.id, normalizedEventVersionId: 'version-1', categoryId: 'cat-civic-life', idempotencyKey: suitability })).rejects.toThrow();
		expect(createdCandidates).not.toHaveBeenCalled();
	});

	it('requires both acknowledgement and reason for SENSITIVE generation', async () => {
		const { repo, createdCandidates } = repository(accepted('SENSITIVE'));
		const service = new GenerationService(repo, new FakeModelProvider());
		const base = { intakeId: intake.id, normalizedEventVersionId: 'version-1', categoryId: 'cat-civic-life', idempotencyKey: 'caution' };
		await expect(service.generateCandidates(identity, base)).rejects.toThrow(/acknowledgement/i);
		await expect(service.generateCandidates(identity, { ...base, cautionAcknowledgement: 'ACKNOWLEDGE CAUTION' })).rejects.toThrow(/reason/i);
		expect(createdCandidates).not.toHaveBeenCalled();
	});

	it('requires a deliberate action and reason for reruns', async () => {
		const { repo, createdCandidates } = repository(accepted(), 1);
		const service = new GenerationService(repo, new FakeModelProvider());
		const base = { intakeId: intake.id, normalizedEventVersionId: 'version-1', categoryId: 'cat-civic-life', idempotencyKey: 'rerun' };
		await expect(service.generateCandidates(identity, base)).rejects.toThrow(/deliberate rerun/i);
		await expect(service.generateCandidates(identity, { ...base, deliberateRerun: 'yes' })).rejects.toThrow(/reason/i);
		expect(createdCandidates).not.toHaveBeenCalled();
	});

	it('fails closed before provider invocation when the daily budget would be exceeded', async () => {
		const { repo, createdCandidates } = repository();
		vi.mocked(repo.sumModelRunCostSince).mockResolvedValue(999_995);
		const provider = new FakeModelProvider();
		const invoke = vi.spyOn(provider, 'generateCandidates');
		const service = new GenerationService(repo, provider, { dailyBudgetMicrousd: 1_000_000 });
		const caught: unknown = await service.generateCandidates(identity, {
			intakeId: intake.id, normalizedEventVersionId: 'version-1', categoryId: 'cat-civic-life', idempotencyKey: 'budget',
		}).catch((error: unknown) => error);
		expect(caught).toMatchObject({ code: 'model-budget' });
		expect(invoke).not.toHaveBeenCalled();
		expect(createdCandidates).not.toHaveBeenCalled();
	});
});
