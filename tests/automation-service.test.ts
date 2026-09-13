import { describe, expect, it, vi } from 'vitest';
import type { CandidateGenerationPort } from '../src/automation/automation-service';
import { AutomationService } from '../src/automation/automation-service';
import { AutomationSourceProviderError, type AutomationSourceProvider } from '../src/automation/source-provider';
import type { AutomationRepository } from '../src/data/automation-repository';
import type {
	AutomationItemResult,
	AutomationReadiness,
	AutomationRun,
	AutomationSource,
	DiscoveryItem,
	DiscoveredSource,
} from '../src/domain/automation';

function source(id: string): DiscoveredSource {
	return {
		itemIdentity: id, title: `Event ${id}`, neutralBrief: `Neutral factual brief for ${id}.`,
		sourceTitle: `Report ${id}`, sourceUrl: `https://news.example.test/${id}`,
		publisherName: 'Newsroom', sourceTier: 'TIER_1', sourceType: 'STRAIGHT_NEWS',
		publishedAt: '2026-09-12T12:00:00.000Z', categoryId: 'cat-civic-life',
	};
}

function item(id: string): DiscoveryItem {
	const value = source(id);
	return { itemIdentity: id, sourceUrl: value.sourceUrl, source: value, errorReason: null };
}

function automationSource(id: string): AutomationSource {
	return {
		itemIdentity: id, sourceUrl: `https://news.example.test/${id}`,
		sourceIntakeId: `intake-${id}`, categoryId: 'cat-civic-life',
		firstSeenAt: '2026-09-12T12:00:00.000Z', lastSeenAt: '2026-09-12T12:00:00.000Z',
	};
}

function harness(options: {
	items?: DiscoveryItem[];
	registered?: AutomationSource[];
	readiness?: Record<string, Partial<AutomationReadiness>>;
	enabled?: boolean;
	maxItems?: number;
	failGenerationFor?: string;
	discoveryError?: Error;
	legacyReferences?: Record<string, string[]>;
} = {}) {
	const registered = [...(options.registered ?? [])];
	const runs: AutomationRun[] = [];
	const recorded: AutomationItemResult[] = [];
	const writes = { starts: 0, completes: 0, items: 0, intakes: 0, registrations: 0 };
	const repository: AutomationRepository = {
		startRun: vi.fn(async (record) => { writes.starts += 1; runs.push({ id: record.id, trigger: record.trigger,
			status: 'RUNNING', discoveredCount: 0, processedCount: 0, intakeCount: 0, generatedCount: 0,
			skippedCount: 0, failedCount: 0, failureReason: null, startedAt: record.startedAt, completedAt: null }); return true; }),
		completeRun: vi.fn(async () => { writes.completes += 1; return true; }),
		recordItem: vi.fn(async (_runId, _itemNumber, result) => { writes.items += 1; recorded.push(result); }),
		categoryExists: vi.fn(async (id) => id === 'cat-civic-life'),
		findSource: vi.fn(async (identity, url) => registered.find((entry) => entry.itemIdentity === identity || entry.sourceUrl === url) ?? null),
		findIntakeIdsBySourceUrl: vi.fn(async (url) => [
			...registered.filter((entry) => entry.sourceUrl === url).map((entry) => entry.sourceIntakeId),
			...(options.legacyReferences?.[url] ?? []),
		]),
		findKnownSources: vi.fn(async (items: readonly Pick<DiscoveryItem, 'itemIdentity' | 'sourceUrl'>[]) => items.flatMap((discovered) => {
			if (!discovered.sourceUrl) return [];
			const found = registered.find((entry) => entry.itemIdentity === discovered.itemIdentity || entry.sourceUrl === discovered.sourceUrl);
			const intakeIds = found
				? [found.sourceIntakeId]
				: options.legacyReferences?.[discovered.sourceUrl] ?? [];
			if (!found && intakeIds.length === 0) return [];
			const readiness = found ? options.readiness?.[found.itemIdentity] : undefined;
			const normalizedEventVersionId = found
				? readiness && Object.hasOwn(readiness, 'normalizedEventVersionId')
					? readiness.normalizedEventVersionId ?? null
					: `version-${found.itemIdentity}`
				: null;
			return [{
				itemIdentity: discovered.itemIdentity,
				sourceUrl: discovered.sourceUrl,
				source: found ?? null,
				sourceIntakeIds: intakeIds,
				normalizedEventVersionId,
				suitability: found ? readiness?.suitability ?? 'SUITABLE' : null,
				successfulGenerationRuns: found ? readiness?.successfulGenerationRuns ?? 0 : 0,
			}];
		})),
		registerExistingSource: vi.fn(async (discovered, intakeId, seenAt) => {
			writes.registrations += 1;
			if (!registered.some((entry) => entry.itemIdentity === discovered.itemIdentity || entry.sourceUrl === discovered.sourceUrl)) {
				registered.push({
					itemIdentity: discovered.itemIdentity, sourceUrl: discovered.sourceUrl,
					sourceIntakeId: intakeId, categoryId: discovered.categoryId,
					firstSeenAt: seenAt, lastSeenAt: seenAt,
				});
			}
			return true;
		}),
		createAutomatedIntake: vi.fn(async (record) => { writes.intakes += 1; registered.push({
			itemIdentity: record.source.itemIdentity, sourceUrl: record.source.sourceUrl,
			sourceIntakeId: record.intakeId, categoryId: record.source.categoryId,
			firstSeenAt: record.createdAt, lastSeenAt: record.createdAt,
		}); return true; }),
		listGenerationReadySources: vi.fn(async (limit) => registered.filter((entry) => {
			const readiness = options.readiness?.[entry.itemIdentity];
			return readiness?.normalizedEventVersionId !== null
				&& (readiness?.suitability ?? 'SUITABLE') === 'SUITABLE'
				&& (readiness?.successfulGenerationRuns ?? 0) === 0;
		}).slice(0, limit)),
		getReadiness: vi.fn(async (entry): Promise<AutomationReadiness> => ({
			source: entry, normalizedEventVersionId: `version-${entry.itemIdentity}`,
			suitability: 'SUITABLE', successfulGenerationRuns: 0,
			...(options.readiness?.[entry.itemIdentity] ?? {}),
		})),
		getLastRun: vi.fn(async () => runs.at(-1) ?? null),
		listRunItems: vi.fn(async () => recorded),
	};
	const provider: AutomationSourceProvider = { discover: vi.fn(async (limit) => {
		if (options.discoveryError) throw options.discoveryError;
		return (options.items ?? []).slice(0, limit);
	}) };
	const generated: string[] = [];
	const candidateGenerator: CandidateGenerationPort = {
		generate: vi.fn(async (input): Promise<{ runId: string; status: 'SUCCEEDED' | 'FAILED' }> => {
			generated.push(input.intakeId);
			if (input.intakeId === options.failGenerationFor) throw new Error('provider failure');
			return { runId: `run-${input.intakeId}`, status: 'SUCCEEDED' };
		}),
	};
	let id = 0;
	const service = new AutomationService(repository, provider, candidateGenerator, {
		enabled: options.enabled ?? true, maxItemsPerRun: options.maxItems ?? 3,
		actorEmail: 'automation@tomorrow-ish.news',
		now: () => '2026-09-12T14:00:00.000Z', createId: () => `id-${++id}`,
	});
	return { service, repository, provider, candidateGenerator, writes, generated, registered };
}

describe('governed intake automation', () => {
	it('creates a normal unreviewed intake for a newly discovered source', async () => {
		const test = harness({ items: [item('new')] });
		const report = await test.service.run({ trigger: 'MANUAL', dryRun: false });
		expect(report.items[0]).toMatchObject({ outcome: 'INTAKE_CREATED', reason: 'AWAITING_EDITORIAL_NORMALIZATION' });
		expect(test.writes.intakes).toBe(1);
		expect(test.candidateGenerator.generate).not.toHaveBeenCalled();
	});

	it('generates candidates for a newly encountered eligible registered source', async () => {
		const test = harness({ items: [item('eligible')], registered: [automationSource('eligible')] });
		const report = await test.service.run({ trigger: 'SCHEDULED', dryRun: false });
		expect(report.items[0]).toMatchObject({ outcome: 'GENERATED', reason: 'FIVE_DRAFT_CANDIDATES_CREATED' });
		expect(test.candidateGenerator.generate).toHaveBeenCalledWith(expect.objectContaining({
			idempotencyKey: 'automation:candidates:v1:version-eligible',
		}));
	});

	it('generates a newly accepted registered source even when it is absent from discovery', async () => {
		const test = harness({ registered: [automationSource('accepted')] });
		const report = await test.service.run({ trigger: 'SCHEDULED', dryRun: false });
		expect(report.items[0]).toMatchObject({ outcome: 'GENERATED', sourceIntakeId: 'intake-accepted' });
	});

	it('records repeated feed identities without colliding in the run log', async () => {
		const test = harness({ items: [item('repeat'), item('repeat')] });
		const report = await test.service.run({ trigger: 'SCHEDULED', dryRun: false });
		expect(report.items.map(({ outcome }) => outcome)).toEqual(['INTAKE_CREATED', 'DUPLICATE']);
		expect(vi.mocked(test.repository.recordItem).mock.calls.map((call) => call[1])).toEqual([1, 2]);
	});

	it('does not let a registered unnormalized source consume useful-work capacity', async () => {
		const test = harness({
			items: [item('known'), item('new-one'), item('new-two')],
			registered: [automationSource('known')],
			readiness: { known: { normalizedEventVersionId: null, suitability: null } },
			maxItems: 2,
		});
		const report = await test.service.run({ trigger: 'MANUAL', dryRun: false });
		expect(report.discoveredCount).toBe(3);
		expect(report.processedCount).toBe(3);
		expect(report.intakeCount).toBe(2);
		expect(report.items).toEqual(expect.arrayContaining([
			expect.objectContaining({ itemIdentity: 'known', outcome: 'DUPLICATE', reason: 'SOURCE_ALREADY_REGISTERED' }),
			expect.objectContaining({ itemIdentity: 'new-one', outcome: 'INTAKE_CREATED' }),
			expect.objectContaining({ itemIdentity: 'new-two', outcome: 'INTAKE_CREATED' }),
		]));
		expect(test.repository.findKnownSources).toHaveBeenCalledTimes(1);
		expect(test.provider.discover).toHaveBeenCalledWith(30);
	});

	it('registers a reference-only legacy item once without creating another intake', async () => {
		const legacy = item('legacy');
		const test = harness({
			items: [legacy],
			legacyReferences: { [legacy.sourceUrl!]: ['intake-legacy'] },
			readiness: { legacy: { normalizedEventVersionId: null, suitability: null } },
			maxItems: 1,
		});
		const first = await test.service.run({ trigger: 'MANUAL', dryRun: false });
		const second = await test.service.run({ trigger: 'MANUAL', dryRun: false });
		expect(first.items[0]).toMatchObject({
			outcome: 'INELIGIBLE', reason: 'AWAITING_EDITORIAL_NORMALIZATION', sourceIntakeId: 'intake-legacy',
		});
		expect(second.items[0]).toMatchObject({ outcome: 'DUPLICATE', reason: 'SOURCE_ALREADY_REGISTERED' });
		expect(test.writes.registrations).toBe(1);
		expect(test.writes.intakes).toBe(0);
	});

	it('does not duplicate candidates for an already-processed source', async () => {
		const test = harness({ items: [item('done')], registered: [automationSource('done')],
			readiness: { done: { successfulGenerationRuns: 1 } } });
		const report = await test.service.run({ trigger: 'SCHEDULED', dryRun: false });
		expect(report.items[0].outcome).toBe('ALREADY_GENERATED');
		expect(test.candidateGenerator.generate).not.toHaveBeenCalled();
	});

	it('skips an ineligible source', async () => {
		const test = harness({ items: [item('unsafe')], registered: [automationSource('unsafe')],
			readiness: { unsafe: { suitability: 'UNSUITABLE' } } });
		const report = await test.service.run({ trigger: 'SCHEDULED', dryRun: false });
		expect(report.items[0]).toMatchObject({ outcome: 'INELIGIBLE', reason: 'SUITABILITY_UNSUITABLE' });
		expect(test.candidateGenerator.generate).not.toHaveBeenCalled();
	});

	it('keeps a registered sensitive source human-only without consuming useful work', async () => {
		const test = harness({
			items: [item('sensitive'), item('new')],
			registered: [automationSource('sensitive')],
			readiness: { sensitive: { suitability: 'SENSITIVE' } },
			maxItems: 1,
		});
		const report = await test.service.run({ trigger: 'SCHEDULED', dryRun: false });
		expect(report.items).toEqual(expect.arrayContaining([
			expect.objectContaining({ itemIdentity: 'sensitive', outcome: 'INELIGIBLE', reason: 'HUMAN_CAUTION_REQUIRED' }),
			expect.objectContaining({ itemIdentity: 'new', outcome: 'INTAKE_CREATED' }),
		]));
		expect(test.candidateGenerator.generate).not.toHaveBeenCalled();
	});

	it('continues after one item generation failure', async () => {
		const test = harness({ items: [item('bad'), item('good')],
			registered: [automationSource('bad'), automationSource('good')], failGenerationFor: 'intake-bad' });
		const report = await test.service.run({ trigger: 'SCHEDULED', dryRun: false });
		expect(report.status).toBe('PARTIAL');
		expect(report.items.map(({ outcome }) => outcome)).toEqual(['FAILED', 'GENERATED']);
		expect(test.generated).toEqual(['intake-bad', 'intake-good']);
	});

	it('never grants approval or publication authority', async () => {
		const test = harness({ items: [item('drafts')], registered: [automationSource('drafts')] });
		await test.service.run({ trigger: 'SCHEDULED', dryRun: false });
		const input = vi.mocked(test.candidateGenerator.generate).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
		expect(input).not.toHaveProperty('status');
		expect(input).not.toHaveProperty('publish');
	});

	it('does nothing when live automation is disabled', async () => {
		const test = harness({ items: [item('disabled')], enabled: false });
		const report = await test.service.run({ trigger: 'SCHEDULED', dryRun: false });
		expect(report.status).toBe('DISABLED');
		expect(test.provider.discover).not.toHaveBeenCalled();
		expect(test.writes).toEqual({ starts: 0, completes: 0, items: 0, intakes: 0, registrations: 0 });
	});

	it('returns disabled without inspecting a blank feed during dry-run', async () => {
		const test = harness({ enabled: false, discoveryError: new AutomationSourceProviderError('NOT_CONFIGURED') });
		const report = await test.service.run({ trigger: 'MANUAL', dryRun: true });
		expect(report).toMatchObject({ status: 'DISABLED', failureReason: null, items: [] });
		expect(test.provider.discover).not.toHaveBeenCalled();
		expect(test.writes).toEqual({ starts: 0, completes: 0, items: 0, intakes: 0, registrations: 0 });
		expect(test.candidateGenerator.generate).not.toHaveBeenCalled();
	});

	it('returns disabled without inspecting a configured feed during dry-run', async () => {
		const test = harness({ enabled: false, items: [item('configured')] });
		const report = await test.service.run({ trigger: 'MANUAL', dryRun: true });
		expect(report.status).toBe('DISABLED');
		expect(test.provider.discover).not.toHaveBeenCalled();
	});

	it.each([true, false])('returns a bounded source failure when enabled with a blank feed (dryRun=%s)', async (dryRun) => {
		const test = harness({ enabled: true, discoveryError: new AutomationSourceProviderError('NOT_CONFIGURED') });
		const report = await test.service.run({ trigger: 'MANUAL', dryRun });
		expect(report).toMatchObject({ status: 'FAILED', failureReason: 'SOURCE_NOT_CONFIGURED', failedCount: 1 });
		expect(test.candidateGenerator.generate).not.toHaveBeenCalled();
		if (dryRun) expect(test.writes).toEqual({ starts: 0, completes: 0, items: 0, intakes: 0, registrations: 0 });
		else expect(test.repository.completeRun).toHaveBeenCalledWith(expect.objectContaining({ failureReason: 'SOURCE_NOT_CONFIGURED' }));
	});

	it('performs no writes and no model calls in enabled dry-run mode', async () => {
		const test = harness({ items: [item('dry')], registered: [automationSource('dry')], enabled: true });
		const report = await test.service.run({ trigger: 'MANUAL', dryRun: true });
		expect(report.items[0]).toMatchObject({ outcome: 'GENERATED', reason: 'DRY_RUN_WOULD_GENERATE' });
		expect(test.writes).toEqual({ starts: 0, completes: 0, items: 0, intakes: 0, registrations: 0 });
		expect(test.candidateGenerator.generate).not.toHaveBeenCalled();
	});

	it('enforces the configured per-run cap', async () => {
		const test = harness({ items: [item('one'), item('two'), item('three')], maxItems: 2 });
		const report = await test.service.run({ trigger: 'MANUAL', dryRun: false, maxItems: 20 });
		expect(report.processedCount).toBe(2);
		expect(test.writes.intakes).toBe(2);
	});

	it('uses the useful-work cap while scanning the fixed discovery horizon', async () => {
		const test = harness({ items: Array.from({ length: 35 }, (_, index) => item(`item-${index}`)), maxItems: 3 });
		const report = await test.service.run({ trigger: 'MANUAL', dryRun: false });
		expect(test.provider.discover).toHaveBeenCalledWith(30);
		expect(report.discoveredCount).toBe(30);
		expect(report.intakeCount).toBe(3);
		expect(test.writes.intakes).toBe(3);
	});
});
