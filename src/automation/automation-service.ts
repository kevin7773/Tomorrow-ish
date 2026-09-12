import type { AutomationRepository } from '../data/automation-repository';
import type {
	AutomationItemResult,
	AutomationReport,
	AutomationSource,
	AutomationTrigger,
	DiscoveryItem,
	DiscoveredSource,
} from '../domain/automation';
import { EditorialValidationError } from '../services/validation';
import { AutomationSourceProviderError, type AutomationSourceProvider } from './source-provider';

const STALE_RUN_MS = 30 * 60 * 1_000;

export interface CandidateGenerationPort {
	generate(input: {
		intakeId: string;
		normalizedEventVersionId: string;
		categoryId: string;
		idempotencyKey: string;
		actorEmail: string;
	}): Promise<{ runId: string; status: 'SUCCEEDED' | 'FAILED' }>;
}

export interface AutomationServiceOptions {
	enabled: boolean;
	maxItemsPerRun: number;
	actorEmail: string;
	now?: () => string;
	createId?: () => string;
}

export interface RunAutomationInput {
	trigger: AutomationTrigger;
	dryRun: boolean;
	maxItems?: number;
}

function boundedReason(error: unknown): string {
	if (error instanceof AutomationSourceProviderError) return `SOURCE_${error.classification}`;
	if (error instanceof EditorialValidationError) return error.code.toUpperCase().replaceAll('-', '_');
	return 'ITEM_FAILURE';
}

function emptyReport(input: RunAutomationInput, status: AutomationReport['status']): AutomationReport {
	return {
		runId: null, trigger: input.trigger, dryRun: input.dryRun, status,
		discoveredCount: 0, processedCount: 0, intakeCount: 0,
		generatedCount: 0, skippedCount: 0, failedCount: 0, failureReason: null, items: [],
	};
}

function itemResult(
	item: Pick<DiscoveryItem, 'itemIdentity' | 'sourceUrl'>,
	outcome: AutomationItemResult['outcome'],
	reason: string,
	context: Partial<Pick<AutomationItemResult, 'sourceIntakeId' | 'normalizedEventVersionId' | 'modelRunId'>> = {},
): AutomationItemResult {
	return {
		itemIdentity: item.itemIdentity, sourceUrl: item.sourceUrl, outcome, reason,
		sourceIntakeId: context.sourceIntakeId ?? null,
		normalizedEventVersionId: context.normalizedEventVersionId ?? null,
		modelRunId: context.modelRunId ?? null,
	};
}

export class AutomationService {
	private readonly now: () => string;
	private readonly createId: () => string;

	constructor(
		private readonly repository: AutomationRepository,
		private readonly sourceProvider: AutomationSourceProvider,
		private readonly candidateGenerator: CandidateGenerationPort,
		private readonly options: AutomationServiceOptions,
	) {
		if (!Number.isSafeInteger(options.maxItemsPerRun) || options.maxItemsPerRun < 1 || options.maxItemsPerRun > 20) {
			throw new Error('Automation item cap must be between 1 and 20.');
		}
		this.now = options.now ?? (() => new Date().toISOString());
		this.createId = options.createId ?? (() => crypto.randomUUID());
	}

	async run(input: RunAutomationInput): Promise<AutomationReport> {
		if (!this.options.enabled) return emptyReport(input, 'DISABLED');
		const cap = Math.min(Math.max(Math.trunc(input.maxItems ?? this.options.maxItemsPerRun), 1), this.options.maxItemsPerRun);
		const startedAt = this.now();
		const runId = input.dryRun ? null : this.createId();
		if (runId) {
			const startedMs = Date.parse(startedAt);
			const started = await this.repository.startRun({
				id: runId,
				trigger: input.trigger,
				startedAt,
				staleBefore: new Date(startedMs - STALE_RUN_MS).toISOString(),
			});
			if (!started) return emptyReport(input, 'ALREADY_RUNNING');
		}

		const report = emptyReport(input, 'RUNNING');
		report.runId = runId;
		let discovered: DiscoveryItem[];
		try {
			discovered = await this.sourceProvider.discover(cap);
			report.discoveredCount = discovered.length;
		} catch (error) {
			const failureReason = boundedReason(error);
			report.status = 'FAILED';
			report.failedCount = 1;
			report.failureReason = failureReason;
			if (runId) await this.repository.completeRun({
				id: runId, status: 'FAILED', discoveredCount: 0, processedCount: 0,
				intakeCount: 0, generatedCount: 0, skippedCount: 0, failedCount: 1,
				failureReason, completedAt: this.now(),
			});
			return report;
		}

		const work = await this.buildWork(discovered, cap);
		const seen = new Set<string>();
		for (const [index, item] of work.entries()) {
			let result: AutomationItemResult;
			if (seen.has(item.itemIdentity)) {
				result = itemResult(item, 'DUPLICATE', 'DUPLICATE_ITEM_IN_RUN');
			} else {
				seen.add(item.itemIdentity);
				try { result = await this.processItem(item, input.dryRun, startedAt); }
				catch (error) { result = itemResult(item, 'FAILED', boundedReason(error)); }
			}
			report.items.push(result);
			report.processedCount += 1;
			if (result.outcome === 'INTAKE_CREATED') report.intakeCount += 1;
			else if (result.outcome === 'GENERATED') report.generatedCount += 1;
			else if (result.outcome === 'FAILED' || result.outcome === 'MALFORMED') report.failedCount += 1;
			else report.skippedCount += 1;
			if (runId) await this.repository.recordItem(runId, index + 1, result, this.now());
		}

		report.status = report.failedCount === 0
			? 'SUCCEEDED'
			: report.failedCount === report.processedCount ? 'FAILED' : 'PARTIAL';
		if (runId) await this.repository.completeRun({
			id: runId, status: report.status, discoveredCount: report.discoveredCount,
			processedCount: report.processedCount, intakeCount: report.intakeCount,
			generatedCount: report.generatedCount, skippedCount: report.skippedCount,
			failedCount: report.failedCount, failureReason: null, completedAt: this.now(),
		});
		return report;
	}

	private async buildWork(discovered: DiscoveryItem[], cap: number): Promise<DiscoveryItem[]> {
		const work: DiscoveryItem[] = [];
		const readyIdentities = new Set<string>();
		for (const source of await this.repository.listGenerationReadySources(cap)) {
			work.push({ itemIdentity: source.itemIdentity, sourceUrl: source.sourceUrl, source: null, errorReason: null });
			readyIdentities.add(source.itemIdentity);
		}
		for (const item of discovered) {
			if (work.length >= cap) break;
			if (readyIdentities.has(item.itemIdentity)) continue;
			work.push(item);
		}
		return work;
	}

	private async processItem(item: DiscoveryItem, dryRun: boolean, seenAt: string): Promise<AutomationItemResult> {
		if (item.errorReason) return itemResult(item, 'MALFORMED', item.errorReason);
		let source = item.sourceUrl ? await this.repository.findSource(item.itemIdentity, item.sourceUrl) : null;
		if (!source && item.source) {
			if (!(await this.repository.categoryExists(item.source.categoryId))) {
				return itemResult(item, 'MALFORMED', 'UNKNOWN_CATEGORY');
			}
			if (dryRun) {
				const intakeIds = await this.repository.findIntakeIdsBySourceUrl(item.source.sourceUrl);
				if (intakeIds.length > 1) return itemResult(item, 'FAILED', 'DUPLICATE_SOURCE_URL_AMBIGUOUS');
				if (intakeIds.length === 0) return itemResult(item, 'INTAKE_CREATED', 'DRY_RUN_WOULD_CREATE_INTAKE');
				source = {
					itemIdentity: item.source.itemIdentity,
					sourceUrl: item.source.sourceUrl,
					sourceIntakeId: intakeIds[0],
					categoryId: item.source.categoryId,
					firstSeenAt: seenAt,
					lastSeenAt: seenAt,
				};
			}
			if (!dryRun) {
				const registered = await this.registerOrCreate(item.source, seenAt);
				source = registered.source;
				if (!source) throw new Error('SOURCE_REGISTRATION_FAILED');
				if (registered.createdIntake) {
					return itemResult(item, 'INTAKE_CREATED', 'AWAITING_EDITORIAL_NORMALIZATION', {
						sourceIntakeId: source.sourceIntakeId,
					});
				}
			}
		}
		if (!source) throw new Error('SOURCE_NOT_REGISTERED');

		const readiness = await this.repository.getReadiness(source);
		const context = {
			sourceIntakeId: source.sourceIntakeId,
			normalizedEventVersionId: readiness.normalizedEventVersionId,
		};
		if (!readiness.normalizedEventVersionId) return itemResult(item, 'INELIGIBLE', 'AWAITING_EDITORIAL_NORMALIZATION', context);
		if (readiness.suitability === 'SENSITIVE') return itemResult(item, 'INELIGIBLE', 'HUMAN_CAUTION_REQUIRED', context);
		if (readiness.suitability !== 'SUITABLE') return itemResult(item, 'INELIGIBLE', `SUITABILITY_${readiness.suitability ?? 'UNKNOWN'}`, context);
		if (readiness.successfulGenerationRuns > 0) return itemResult(item, 'ALREADY_GENERATED', 'SUCCESSFUL_GENERATION_EXISTS', context);
		if (dryRun) return itemResult(item, 'GENERATED', 'DRY_RUN_WOULD_GENERATE', context);

		const generated = await this.candidateGenerator.generate({
			intakeId: source.sourceIntakeId,
			normalizedEventVersionId: readiness.normalizedEventVersionId,
			categoryId: source.categoryId,
			idempotencyKey: `automation:candidates:v1:${readiness.normalizedEventVersionId}`,
			actorEmail: this.options.actorEmail,
		});
		if (generated.status !== 'SUCCEEDED') return itemResult(item, 'FAILED', 'GENERATION_RUN_FAILED', {
			...context, modelRunId: generated.runId,
		});
		return itemResult(item, 'GENERATED', 'FIVE_DRAFT_CANDIDATES_CREATED', {
			...context, modelRunId: generated.runId,
		});
	}

	private async registerOrCreate(discovered: DiscoveredSource, seenAt: string): Promise<{
		source: AutomationSource | null;
		createdIntake: boolean;
	}> {
		const intakeIds = await this.repository.findIntakeIdsBySourceUrl(discovered.sourceUrl);
		if (intakeIds.length > 1) throw new EditorialValidationError('Source URL belongs to multiple intakes.', 'duplicate');
		if (intakeIds.length === 1) {
			await this.repository.registerExistingSource(discovered, intakeIds[0], seenAt);
			return {
				source: await this.repository.findSource(discovered.itemIdentity, discovered.sourceUrl),
				createdIntake: false,
			};
		}
		const created = await this.repository.createAutomatedIntake({
			source: discovered, intakeId: this.createId(), referenceId: this.createId(),
			actorEmail: this.options.actorEmail, createdAt: seenAt,
			auditIds: [this.createId(), this.createId()],
		});
		return {
			source: await this.repository.findSource(discovered.itemIdentity, discovered.sourceUrl),
			createdIntake: created,
		};
	}
}
