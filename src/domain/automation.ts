import type { SatireSuitability, SourceTier, SourceType } from './editorial';

export type AutomationTrigger = 'MANUAL' | 'SCHEDULED';
export type AutomationRunStatus = 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
export type AutomationItemOutcome =
	| 'INTAKE_CREATED'
	| 'GENERATED'
	| 'DUPLICATE'
	| 'INELIGIBLE'
	| 'ALREADY_GENERATED'
	| 'MALFORMED'
	| 'FAILED';

export interface DiscoveredSource {
	itemIdentity: string;
	title: string;
	neutralBrief: string;
	sourceTitle: string;
	sourceUrl: string;
	publisherName: string;
	sourceTier: SourceTier;
	sourceType: SourceType;
	publishedAt: string | null;
	categoryId: string;
}

export interface DiscoveryItem {
	itemIdentity: string;
	sourceUrl: string | null;
	source: DiscoveredSource | null;
	errorReason: string | null;
}

export interface AutomationSource {
	itemIdentity: string;
	sourceUrl: string;
	sourceIntakeId: string;
	categoryId: string;
	firstSeenAt: string;
	lastSeenAt: string;
}

export interface AutomationReadiness {
	source: AutomationSource;
	normalizedEventVersionId: string | null;
	suitability: SatireSuitability | null;
	successfulGenerationRuns: number;
}

export interface AutomationRun {
	id: string;
	trigger: AutomationTrigger;
	status: AutomationRunStatus;
	discoveredCount: number;
	processedCount: number;
	intakeCount: number;
	generatedCount: number;
	skippedCount: number;
	failedCount: number;
	failureReason: string | null;
	startedAt: string;
	completedAt: string | null;
}

export interface AutomationItemResult {
	itemIdentity: string;
	sourceUrl: string | null;
	outcome: AutomationItemOutcome;
	reason: string;
	sourceIntakeId: string | null;
	normalizedEventVersionId: string | null;
	modelRunId: string | null;
}

export interface AutomationReport {
	runId: string | null;
	trigger: AutomationTrigger;
	dryRun: boolean;
	status: AutomationRunStatus | 'DISABLED' | 'ALREADY_RUNNING';
	discoveredCount: number;
	processedCount: number;
	intakeCount: number;
	generatedCount: number;
	skippedCount: number;
	failedCount: number;
	items: AutomationItemResult[];
}
