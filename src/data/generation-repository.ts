import type { CandidateStatus, EditorialIdentity, SourceIntake } from '../domain/editorial';
import type {
	CandidateProposal,
	GuardrailFlag,
	ModelRun,
	NormalizedEventVersion,
	NormalizationProposal,
} from '../domain/generation';

export interface ModelRunRecord {
	id: string;
	operation: ModelRun['operation'];
	status: ModelRun['status'];
	sourceIntakeId: string;
	normalizedEventVersionId: string | null;
	provider: string;
	model: string;
	providerRevision: string | null;
	promptVersion: string;
	inputHash: string;
	outputHash: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	inputCharacters: number;
	outputCharacters: number;
	latencyMs: number;
	retryCount: number;
	estimatedCostMicrousd: number;
	candidateCount: number;
	idempotencyKey: string;
	requestedByEmail: string;
	failureClassification: string | null;
	providerHttpStatus: number | null;
	providerErrorType: string | null;
	providerErrorCode: string | null;
	providerErrorMessage: string | null;
	providerRequestId: string | null;
	providerRetryAfter: string | null;
	createdAt: string;
	completedAt: string;
}

export interface CreateNormalizationRecord {
	run: ModelRunRecord;
	versionId: string;
	versionNumber: number;
	proposal: NormalizationProposal;
	assertionIds: string[];
	createdAt: string;
}

export interface CreateEditorRevisionRecord {
	versionId: string;
	parent: NormalizedEventVersion;
	versionNumber: number;
	proposal: NormalizationProposal;
	assertionIds: string[];
	actorEmail: string;
	createdAt: string;
	auditId: string;
	revisionReason: string;
}

export interface ReviewNormalizationRecord {
	versionId: string;
	intakeId: string;
	decision: 'ACCEPTED' | 'REJECTED';
	reason: string;
	actorEmail: string;
	reviewedAt: string;
	auditId: string;
	proposal: NormalizationProposal;
	modelRunId: string | null;
}

export interface CreateGeneratedCandidatesRecord {
	run: ModelRunRecord;
	categoryId: string;
	candidates: CandidateProposal[];
	candidateIds: string[];
	auditIds: string[];
	createdAt: string;
	editorialReason: string;
}

export interface ArticleBodyGenerationCandidate {
	id: string;
	sourceIntakeId: string;
	proposedHeadline: string;
	proposedDeck: string;
	draftBodyMarkdown: string;
	categoryId: string;
	categoryName: string;
	editorialNotes: string;
	status: CandidateStatus;
	normalizedEventVersionId: string | null;
	rationale: string;
	satiricalMechanism: string;
	bodyGenerationState: 'NOT_REQUESTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED';
	bodyGenerationRunId: string | null;
}

export interface ArticleBodyGenerationContext {
	candidate: ArticleBodyGenerationCandidate;
	intake: SourceIntake;
	version: NormalizedEventVersion | null;
}

export interface ArticleBodyGenerationRunSummary {
	id: string;
	candidateId: string;
	status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
}

export interface ClaimArticleBodyGenerationRecord {
	id: string;
	candidateId: string;
	sourceIntakeId: string;
	normalizedEventVersionId: string;
	provider: string;
	model: string;
	promptVersion: string;
	inputHash: string;
	inputCharacters: number;
	estimatedCostMicrousd: number;
	idempotencyKey: string;
	requestedByEmail: string;
	sourceWasSensitive: boolean;
	cautionReason: string | null;
	createdAt: string;
	auditId: string;
}

export interface CompleteArticleBodyGenerationRecord {
	run: ModelRunRecord;
	candidateId: string;
	bodyMarkdown: string;
	actorEmail: string;
	completedAt: string;
	auditId: string;
}

export interface FailArticleBodyGenerationRecord {
	runId: string;
	candidateId: string;
	providerRevision: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	outputCharacters: number;
	latencyMs: number;
	estimatedCostMicrousd: number;
	failureClassification: string;
	providerHttpStatus: number | null;
	providerErrorType: string | null;
	providerErrorCode: string | null;
	providerErrorMessage: string | null;
	providerRequestId: string | null;
	providerRetryAfter: string | null;
	actorEmail: string;
	completedAt: string;
	auditId: string;
}

export interface ResolveStaleArticleBodyGenerationRecord {
	runId: string;
	candidateId: string;
	actorEmail: string;
	staleBefore: string;
	resolvedAt: string;
	auditId: string;
}

export interface GenerationRepository {
	findIntakeForGeneration(id: string): Promise<SourceIntake | null>;
	getNextNormalizedVersionNumber(intakeId: string): Promise<number>;
	listNormalizedVersions(intakeId: string): Promise<NormalizedEventVersion[]>;
	findNormalizedVersion(id: string): Promise<NormalizedEventVersion | null>;
	findAcceptedNormalizedVersion(intakeId: string): Promise<NormalizedEventVersion | null>;
	findModelRun(id: string): Promise<ModelRun | null>;
	findModelRunByIdempotencyKey(key: string): Promise<ModelRun | null>;
	findArticleBodyRunByIdempotencyKey(key: string): Promise<ArticleBodyGenerationRunSummary | null>;
	findCandidateForBodyGeneration(id: string): Promise<ArticleBodyGenerationContext | null>;
	createModelRun(run: ModelRunRecord): Promise<void>;
	sumModelRunCostSince(createdAt: string): Promise<number>;
	countSuccessfulGenerationRuns(versionId: string): Promise<number>;
	categoryExists(id: string): Promise<boolean>;
	createNormalization(record: CreateNormalizationRecord): Promise<void>;
	createEditorRevision(record: CreateEditorRevisionRecord): Promise<void>;
	reviewNormalization(record: ReviewNormalizationRecord): Promise<boolean>;
	supersedeNormalization(record: Omit<ReviewNormalizationRecord, 'decision' | 'proposal' | 'modelRunId'>): Promise<boolean>;
	createGeneratedCandidates(record: CreateGeneratedCandidatesRecord): Promise<boolean>;
	claimArticleBodyGeneration(record: ClaimArticleBodyGenerationRecord): Promise<boolean>;
	completeArticleBodyGeneration(record: CompleteArticleBodyGenerationRecord): Promise<boolean>;
	failArticleBodyGeneration(record: FailArticleBodyGenerationRecord): Promise<boolean>;
	resolveStaleArticleBodyGeneration(record: ResolveStaleArticleBodyGenerationRecord): Promise<boolean>;
	countGeneratedCandidates(runId: string): Promise<number>;
}

export function editorEmail(identity: EditorialIdentity | null | undefined): string {
	if (!identity?.email) throw new Error('An authenticated editor is required.');
	return identity.email.trim().toLowerCase();
}

export function parseGuardrailFlags(value: string): GuardrailFlag[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed as GuardrailFlag[] : [];
	} catch {
		return [];
	}
}
