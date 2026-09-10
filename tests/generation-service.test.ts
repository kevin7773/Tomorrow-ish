import { describe, expect, it, vi } from 'vitest';
import { FakeModelProvider } from '../src/ai/fake-model-provider';
import type { GenerationRepository } from '../src/data/generation-repository';
import type { SourceIntake } from '../src/domain/editorial';
import type { ModelRun, NormalizedEventVersion } from '../src/domain/generation';
import { GenerationService } from '../src/services/generation-service';

const identity = { email: 'editor@example.com' };
const intake: SourceIntake = {
	id: 'intake-1', title: 'Agency Opens Drawer', neutralBrief: 'A drawer was opened.',
	significanceScore: 1, satirePotentialScore: 1, satireSuitability: 'UNREVIEWED', editorialNotes: '',
	suitabilityReason: '', guardrailFlags: [], assessmentReviewedByEmail: null, assessmentReviewedAt: null,
	acceptedModelRunId: null, createdByEmail: identity.email, updatedByEmail: identity.email,
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

function repository(version = accepted(), previousRuns = 0) {
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
		countSuccessfulGenerationRuns: vi.fn(async () => previousRuns), categoryExists: vi.fn(async () => true),
		createNormalization: createdNormalization, createEditorRevision: vi.fn(async () => undefined),
		reviewNormalization: vi.fn(async () => true), createGeneratedCandidates: createdCandidates,
		supersedeNormalization: vi.fn(async () => true),
		countGeneratedCandidates: vi.fn(async () => 0),
	} as unknown as GenerationRepository;
	return { repo, createdCandidates, createdNormalization };
}

describe('generation authority', () => {
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
});
