import type {
	AutomationItemResult,
	AutomationReadiness,
	AutomationRun,
	AutomationSource,
	AutomationTrigger,
	DiscoveryItem,
	DiscoveredSource,
} from '../domain/automation';

export interface KnownAutomationDiscovery {
	itemIdentity: string;
	sourceUrl: string;
	source: AutomationSource | null;
	sourceIntakeIds: string[];
	normalizedEventVersionId: string | null;
	suitability: AutomationReadiness['suitability'];
	successfulGenerationRuns: number;
}

export interface StartAutomationRunRecord {
	id: string;
	trigger: AutomationTrigger;
	startedAt: string;
	staleBefore: string;
}

export interface CompleteAutomationRunRecord {
	id: string;
	status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
	discoveredCount: number;
	processedCount: number;
	intakeCount: number;
	generatedCount: number;
	skippedCount: number;
	failedCount: number;
	failureReason: string | null;
	completedAt: string;
}

export interface CreateAutomatedIntakeRecord {
	source: DiscoveredSource;
	intakeId: string;
	referenceId: string;
	actorEmail: string;
	createdAt: string;
	auditIds: [string, string];
}

export interface AutomationRepository {
	startRun(record: StartAutomationRunRecord): Promise<boolean>;
	completeRun(record: CompleteAutomationRunRecord): Promise<boolean>;
	recordItem(runId: string, itemNumber: number, result: AutomationItemResult, createdAt: string): Promise<void>;
	categoryExists(categoryId: string): Promise<boolean>;
	findSource(itemIdentity: string, sourceUrl: string): Promise<AutomationSource | null>;
	findIntakeIdsBySourceUrl(sourceUrl: string): Promise<string[]>;
	findKnownSources(items: readonly Pick<DiscoveryItem, 'itemIdentity' | 'sourceUrl'>[]): Promise<KnownAutomationDiscovery[]>;
	registerExistingSource(source: DiscoveredSource, intakeId: string, seenAt: string): Promise<boolean>;
	createAutomatedIntake(record: CreateAutomatedIntakeRecord): Promise<boolean>;
	listGenerationReadySources(limit: number): Promise<AutomationSource[]>;
	getReadiness(source: AutomationSource): Promise<AutomationReadiness>;
	getLastRun(): Promise<AutomationRun | null>;
	listRunItems(runId: string): Promise<AutomationItemResult[]>;
}
