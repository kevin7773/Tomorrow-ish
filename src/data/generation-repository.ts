import type { EditorialIdentity, SourceIntake } from '../domain/editorial';
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

export interface GenerationRepository {
	findIntakeForGeneration(id: string): Promise<SourceIntake | null>;
	getNextNormalizedVersionNumber(intakeId: string): Promise<number>;
	listNormalizedVersions(intakeId: string): Promise<NormalizedEventVersion[]>;
	findNormalizedVersion(id: string): Promise<NormalizedEventVersion | null>;
	findAcceptedNormalizedVersion(intakeId: string): Promise<NormalizedEventVersion | null>;
	findModelRun(id: string): Promise<ModelRun | null>;
	findModelRunByIdempotencyKey(key: string): Promise<ModelRun | null>;
	createModelRun(run: ModelRunRecord): Promise<void>;
	sumModelRunCostSince(createdAt: string): Promise<number>;
	countSuccessfulGenerationRuns(versionId: string): Promise<number>;
	categoryExists(id: string): Promise<boolean>;
	createNormalization(record: CreateNormalizationRecord): Promise<void>;
	createEditorRevision(record: CreateEditorRevisionRecord): Promise<void>;
	reviewNormalization(record: ReviewNormalizationRecord): Promise<boolean>;
	supersedeNormalization(record: Omit<ReviewNormalizationRecord, 'decision' | 'proposal' | 'modelRunId'>): Promise<boolean>;
	createGeneratedCandidates(record: CreateGeneratedCandidatesRecord): Promise<boolean>;
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
