import type { ModelProvider } from '../ai/model-provider';
import { ModelOutputError, ModelProviderError } from '../ai/model-provider';
import { parseArticleBodyProposal, parseCandidateBatch, parseNormalizationProposal } from '../ai/validation';
import {
	CANDIDATE_PROMPT_VERSION,
	ARTICLE_BODY_PROMPT_VERSION,
	DEFAULT_MODEL_LIMITS,
	HOUSE_VOICE_CONTRACT,
	ModelExecutionError,
	ModelLimitError,
	NORMALIZATION_PROMPT_VERSION,
	modelLimitsForOperation,
	runWithLimits,
	sha256,
	type ModelLimits,
} from '../ai/model-runner';
import type { GenerationRepository, ModelRunRecord } from '../data/generation-repository';
import type { EditorialIdentity } from '../domain/editorial';
import {
	deterministicGuardrailFlags,
	hasAuthoritativeFactSupport,
	mergeGuardrailFlags,
	type ModelResult,
	type ModelOperation,
	type NormalizationProposal,
} from '../domain/generation';
import type { GenerateArticleBodyInput } from '../ai/model-provider';
import type { ProviderResponseDiagnostics } from '../ai/model-provider';
import { EditorialValidationError, requiredText } from './validation';

const STALE_BODY_GENERATION_MINIMUM_MS = 60 * 60 * 1_000;

interface GenerationDependencies {
	now?: () => string;
	createId?: () => string;
	limits?: Readonly<ModelLimits>;
	dailyBudgetMicrousd?: number;
	generationEnabled?: boolean;
}

function actor(identity: EditorialIdentity | null | undefined): string {
	if (!identity?.email) throw new EditorialValidationError('An authenticated editor is required.', 'unauthorized');
	return identity.email.trim().toLowerCase();
}

function idempotencyKey(value: unknown): string {
	return requiredText(value, 'Idempotency key', 200);
}

type ArticleBodyFactFailureClassification =
	| 'MALFORMED_OUTPUT_FACT_IDS_EMPTY'
	| 'MALFORMED_OUTPUT_FACT_ID_NOT_ACCEPTED'
	| 'MALFORMED_OUTPUT_FACT_ID_DUPLICATE';

class ArticleBodyFactValidationError extends ModelOutputError {
	constructor(readonly failureClassification: ArticleBodyFactFailureClassification) {
		super('Article body factual provenance is invalid.');
	}
}

function sanitizedFailure(error: unknown): string {
	if (error instanceof ModelExecutionError) return sanitizedFailure(error.cause);
	if (error instanceof ArticleBodyFactValidationError) return error.failureClassification;
	if (error instanceof ModelOutputError) return 'MALFORMED_OUTPUT';
	if (error instanceof ModelLimitError) return 'MODEL_LIMIT';
	if (error instanceof ModelProviderError) return error.failureClassification;
	if (error instanceof DOMException && error.name === 'AbortError') return 'TIMEOUT';
	return 'PROVIDER_FAILURE';
}

function providerResponseDiagnostics(error: unknown): ProviderResponseDiagnostics | null {
	if (error instanceof ModelExecutionError) return providerResponseDiagnostics(error.cause);
	return error instanceof ModelProviderError ? error.responseDiagnostics : null;
}

function persistedProviderDiagnostics(error: unknown): Pick<ModelRunRecord,
	'providerHttpStatus' | 'providerErrorType' | 'providerErrorCode' | 'providerErrorMessage' |
	'providerRequestId' | 'providerRetryAfter'> {
	const diagnostics = providerResponseDiagnostics(error);
	return {
		providerHttpStatus: diagnostics?.httpStatus ?? null,
		providerErrorType: diagnostics?.errorType ?? null,
		providerErrorCode: diagnostics?.errorCode ?? null,
		providerErrorMessage: diagnostics?.errorMessage ?? null,
		providerRequestId: diagnostics?.requestId ?? null,
		providerRetryAfter: diagnostics?.retryAfter ?? null,
	};
}

function editorialModelFailure(error: unknown): EditorialValidationError {
	const classification = sanitizedFailure(error);
	if (['PROVIDER_NETWORK', 'PROVIDER_SERVER', 'PROVIDER_RATE_LIMIT', 'TIMEOUT'].includes(classification)) {
		return new EditorialValidationError('The model provider could not be reached.', 'provider-unavailable');
	}
	if (['PROVIDER_AUTHENTICATION', 'PROVIDER_REQUEST'].includes(classification)) {
		return new EditorialValidationError('The model provider rejected the request.', 'provider-rejected');
	}
	if (classification === 'MALFORMED_OUTPUT' || classification.startsWith('MALFORMED_OUTPUT_')) {
		return new EditorialValidationError('The model provider returned invalid output.', 'provider-invalid-output');
	}
	if (['PROVIDER_CONFIGURATION', 'PROVIDER_DISABLED'].includes(classification)) {
		return new EditorialValidationError('Model generation is disabled or is not configured.', 'model-disabled');
	}
	return new EditorialValidationError('The model operation could not be completed.', 'operation-failed');
}

function proposalFromVersion(version: Awaited<ReturnType<GenerationRepository['findNormalizedVersion']>>): NormalizationProposal {
	if (!version) throw new EditorialValidationError('The normalized event was not found.', 'not-found');
	return {
		eventStatement: version.eventStatement,
		assertions: version.assertions.map(({ kind, statement, sources }) => ({ kind, statement, sources })),
		proposedSignificanceScore: version.proposedSignificanceScore,
		proposedSatirePotentialScore: version.proposedSatirePotentialScore,
		proposedSuitability: version.proposedSuitability,
		suitabilityReason: version.suitabilityReason,
		guardrailFlags: version.guardrailFlags,
	};
}

export class GenerationService {
	private readonly now: () => string;
	private readonly createId: () => string;
	private readonly limits: Readonly<ModelLimits>;
	private readonly dailyBudgetMicrousd: number;
	private readonly generationEnabled: boolean;

	constructor(
		private readonly repository: GenerationRepository,
		private readonly provider: ModelProvider,
		dependencies: GenerationDependencies = {},
	) {
		this.now = dependencies.now ?? (() => new Date().toISOString());
		this.createId = dependencies.createId ?? (() => crypto.randomUUID());
		this.limits = dependencies.limits ?? DEFAULT_MODEL_LIMITS;
		this.dailyBudgetMicrousd = dependencies.dailyBudgetMicrousd ?? 1_000_000;
		this.generationEnabled = dependencies.generationEnabled ?? true;
		if (!Number.isSafeInteger(this.dailyBudgetMicrousd) || this.dailyBudgetMicrousd <= 0) {
			throw new EditorialValidationError('The daily model budget is invalid.');
		}
	}

	async proposeNormalization(identity: EditorialIdentity, intakeIdValue: unknown, keyValue: unknown): Promise<string> {
		const requestedByEmail = actor(identity);
		const intakeId = requiredText(intakeIdValue, 'Intake ID', 100);
		const key = idempotencyKey(keyValue);
		const existing = await this.repository.findModelRunByIdempotencyKey(key);
		if (existing) {
			if (existing.operation !== 'NORMALIZE' || existing.sourceIntakeId !== intakeId) {
				throw new EditorialValidationError('The idempotency key belongs to another operation.');
			}
			if (!existing.normalizedEventVersionId) throw new EditorialValidationError('The prior model run failed.');
			return existing.normalizedEventVersionId;
		}
		const intake = await this.repository.findIntakeForGeneration(intakeId);
		if (!intake) throw new EditorialValidationError('The intake was not found.', 'not-found');
		if (intake.references.length === 0) throw new EditorialValidationError('At least one source reference is required.');

		const input = { title: intake.title, neutralBrief: intake.neutralBrief, references: intake.references };
		const inputText = JSON.stringify(input);
		const createdAt = this.now();
		const reservedCostMicrousd = await this.requireBudget('NORMALIZE', inputText.length, createdAt);
		const runId = this.createId();
		let executed: { result: ModelResult<unknown>; retryCount: number; latencyMs: number } | null = null;
		try {
			executed = await runWithLimits((signal) => this.provider.normalizeEvent(input, signal), inputText.length,
				modelLimitsForOperation('NORMALIZE', this.limits));
			const parsed = parseNormalizationProposal(executed.result.output);
			const referenceIds = new Set(intake.references.map((reference) => reference.id));
			if (parsed.assertions.some((assertion) => assertion.sources.some((source) => !referenceIds.has(source.sourceReferenceId)))) {
				throw new ModelOutputError('Normalization cited a source outside the intake.');
			}
			const deterministic = deterministicGuardrailFlags(`${intake.title}\n${intake.neutralBrief}`);
			parsed.guardrailFlags = mergeGuardrailFlags(deterministic, parsed.guardrailFlags);
			if (parsed.assertions.some((assertion) => !hasAuthoritativeFactSupport(assertion, intake.references))) {
				throw new ModelOutputError('A factual assertion lacks authoritative support.');
			}
			const outputText = JSON.stringify(parsed);
			const versionId = this.createId();
			const completedAt = this.now();
			await this.repository.createNormalization({
				run: await this.runRecord({ id: runId, operation: 'NORMALIZE', sourceIntakeId: intakeId,
					normalizedEventVersionId: versionId, key, requestedByEmail, createdAt, completedAt,
					promptVersion: NORMALIZATION_PROMPT_VERSION, inputText, outputText, executed }),
				versionId,
				versionNumber: await this.repository.getNextNormalizedVersionNumber(intakeId),
				proposal: parsed,
				assertionIds: parsed.assertions.map(() => this.createId()),
				createdAt: completedAt,
			});
			return versionId;
		} catch (error) {
			const raced = await this.repository.findModelRunByIdempotencyKey(key);
			if (raced?.operation === 'NORMALIZE' && raced.sourceIntakeId === intakeId && raced.normalizedEventVersionId) {
				return raced.normalizedEventVersionId;
			}
			const completedAt = this.now();
			const failed: ModelRunRecord = {
				id: runId, operation: 'NORMALIZE', status: 'FAILED', sourceIntakeId: intakeId,
				normalizedEventVersionId: null, provider: this.provider.providerId, model: this.provider.modelId,
				providerRevision: null, promptVersion: NORMALIZATION_PROMPT_VERSION,
				inputHash: await sha256(`${NORMALIZATION_PROMPT_VERSION}\n${inputText}`), outputHash: null,
				inputTokens: executed?.result.usage.inputTokens ?? null, outputTokens: executed?.result.usage.outputTokens ?? null,
				inputCharacters: inputText.length, outputCharacters: executed?.result.usage.outputCharacters ?? 0,
				retryCount: error instanceof ModelExecutionError ? error.retryCount : executed?.retryCount ?? 0,
				latencyMs: error instanceof ModelExecutionError ? error.latencyMs : executed?.latencyMs ?? 0,
				estimatedCostMicrousd: executed?.result.usage.estimatedCostMicrousd ?? reservedCostMicrousd, candidateCount: 0, idempotencyKey: key,
				requestedByEmail, failureClassification: sanitizedFailure(error), createdAt, completedAt,
				...persistedProviderDiagnostics(error),
			};
			await this.repository.createModelRun(failed);
			throw editorialModelFailure(error);
		}
	}

	async createEditorRevision(identity: EditorialIdentity, parentIdValue: unknown, rawProposal: unknown, revisionReasonValue: unknown): Promise<string> {
		const actorEmail = actor(identity);
		const parentId = requiredText(parentIdValue, 'Parent version ID', 100);
		const parent = await this.repository.findNormalizedVersion(parentId);
		if (!parent) throw new EditorialValidationError('The normalized event was not found.', 'not-found');
		const intake = await this.repository.findIntakeForGeneration(parent.sourceIntakeId);
		if (!intake) throw new EditorialValidationError('The intake was not found.', 'not-found');
		const proposal = parseNormalizationProposal(rawProposal);
		const revisionReason = requiredText(revisionReasonValue, 'Revision reason', 2_000);
		proposal.guardrailFlags = mergeGuardrailFlags(
			deterministicGuardrailFlags(`${intake.title}\n${intake.neutralBrief}`),
			proposal.guardrailFlags,
		);
		if (proposal.assertions.some((assertion) => !hasAuthoritativeFactSupport(assertion, intake.references))) {
			throw new EditorialValidationError('Every FACT assertion requires non-context authoritative support.');
		}
		const id = this.createId();
		const createdAt = this.now();
		await this.repository.createEditorRevision({
			versionId: id, parent, versionNumber: await this.repository.getNextNormalizedVersionNumber(parent.sourceIntakeId),
			proposal, assertionIds: proposal.assertions.map(() => this.createId()), actorEmail, createdAt,
			auditId: this.createId(), revisionReason,
		});
		return id;
	}

	async reviewNormalization(identity: EditorialIdentity, versionIdValue: unknown, decisionValue: unknown, reasonValue: unknown): Promise<void> {
		const actorEmail = actor(identity);
		const versionId = requiredText(versionIdValue, 'Version ID', 100);
		const decision = decisionValue === 'ACCEPTED' || decisionValue === 'REJECTED' ? decisionValue : null;
		if (!decision) throw new EditorialValidationError('Review decision is invalid.');
		const reason = requiredText(reasonValue, 'Review reason', 2_000);
		const version = await this.repository.findNormalizedVersion(versionId);
		if (!version || version.reviewState !== 'PROPOSED') throw new EditorialValidationError('Only a proposed version can be reviewed.');
		const intake = await this.repository.findIntakeForGeneration(version.sourceIntakeId);
		if (!intake) throw new EditorialValidationError('The intake was not found.', 'not-found');
		if (decision === 'ACCEPTED' && version.assertions.some((assertion) => !hasAuthoritativeFactSupport(assertion, intake.references))) {
			throw new EditorialValidationError('Every FACT assertion requires non-context authoritative support.');
		}
		const changed = await this.repository.reviewNormalization({ versionId, intakeId: version.sourceIntakeId,
			decision, reason, actorEmail, reviewedAt: this.now(), auditId: this.createId(),
			proposal: proposalFromVersion(version), modelRunId: version.modelRunId });
		if (!changed) throw new EditorialValidationError('The normalized version changed; reload and retry.');
	}

	async supersedeNormalization(identity: EditorialIdentity, versionIdValue: unknown, reasonValue: unknown): Promise<void> {
		const actorEmail = actor(identity);
		const versionId = requiredText(versionIdValue, 'Version ID', 100);
		const reason = requiredText(reasonValue, 'Supersede reason', 2_000);
		const version = await this.repository.findNormalizedVersion(versionId);
		if (!version || version.reviewState !== 'ACCEPTED') throw new EditorialValidationError('Only an accepted version can be superseded.');
		const changed = await this.repository.supersedeNormalization({ versionId, intakeId: version.sourceIntakeId,
			reason, actorEmail, reviewedAt: this.now(), auditId: this.createId() });
		if (!changed) throw new EditorialValidationError('The normalized version changed; reload and retry.');
	}

	async generateCandidates(identity: EditorialIdentity, input: Record<string, unknown>): Promise<string> {
		const requestedByEmail = actor(identity);
		const intakeId = requiredText(input.intakeId, 'Intake ID', 100);
		const versionId = requiredText(input.normalizedEventVersionId, 'Normalized event version ID', 100);
		const categoryId = requiredText(input.categoryId, 'Category ID', 100);
		const key = idempotencyKey(input.idempotencyKey);
		const existing = await this.repository.findModelRunByIdempotencyKey(key);
		if (existing) {
			if (existing.operation !== 'GENERATE_CANDIDATES' || existing.normalizedEventVersionId !== versionId) {
				throw new EditorialValidationError('The idempotency key belongs to another operation.');
			}
			return existing.id;
		}
		const version = await this.repository.findAcceptedNormalizedVersion(intakeId);
		if (!version || version.id !== versionId) throw new EditorialValidationError('Only the accepted normalized-event version may generate candidates.');
		if (!(await this.repository.categoryExists(categoryId))) throw new EditorialValidationError('Category is invalid.');
		if (version.proposedSuitability === 'UNSUITABLE') throw new EditorialValidationError('Unsuitable events cannot generate satire.');
		if (version.proposedSuitability === 'UNREVIEWED') throw new EditorialValidationError('Suitability must be reviewed before generation.');
		let editorialReason = '';
		if (version.proposedSuitability === 'SENSITIVE') {
			if (input.cautionAcknowledgement !== 'ACKNOWLEDGE CAUTION') throw new EditorialValidationError('Caution acknowledgement is required.');
			editorialReason = requiredText(input.editorialReason, 'Editorial reason', 2_000);
		}
		const previousRuns = await this.repository.countSuccessfulGenerationRuns(versionId);
		if (previousRuns > 0) {
			if (input.deliberateRerun !== 'yes') throw new EditorialValidationError('A deliberate rerun must be explicitly selected.');
			editorialReason = requiredText(input.editorialReason, 'Rerun reason', 2_000);
		}
		const modelInput = {
			eventStatement: version.eventStatement,
			facts: version.assertions.filter((item) => item.kind === 'FACT').map((item) => item.statement),
			uncertainties: version.assertions.filter((item) => item.kind === 'UNCERTAINTY').map((item) => item.statement),
			context: version.assertions.filter((item) => item.kind === 'CONTEXT').map((item) => item.statement),
			suitabilityReason: version.suitabilityReason,
			guardrailFlags: version.guardrailFlags,
			count: this.limits.defaultCandidateCount,
		};
		const inputText = `${HOUSE_VOICE_CONTRACT}\n${JSON.stringify(modelInput)}`;
		const runId = this.createId();
		const createdAt = this.now();
		const reservedCostMicrousd = await this.requireBudget('GENERATE_CANDIDATES', inputText.length, createdAt);
		let executed: { result: ModelResult<unknown>; retryCount: number; latencyMs: number } | null = null;
		try {
			executed = await runWithLimits((signal) => this.provider.generateCandidates(modelInput, signal), inputText.length,
				modelLimitsForOperation('GENERATE_CANDIDATES', this.limits));
			const candidates = parseCandidateBatch(executed.result.output, this.limits.defaultCandidateCount);
			const outputText = JSON.stringify(candidates);
			const completedAt = this.now();
			const created = await this.repository.createGeneratedCandidates({
				run: await this.runRecord({ id: runId, operation: 'GENERATE_CANDIDATES', sourceIntakeId: intakeId,
					normalizedEventVersionId: versionId, key, requestedByEmail, createdAt, completedAt,
					promptVersion: CANDIDATE_PROMPT_VERSION, inputText, outputText, executed }),
				categoryId, candidates, candidateIds: candidates.map(() => this.createId()),
				auditIds: candidates.map(() => this.createId()), createdAt: completedAt, editorialReason,
			});
			if (!created) throw new EditorialValidationError('Candidates could not be created.');
			return runId;
		} catch (error) {
			if (error instanceof EditorialValidationError) throw error;
			const raced = await this.repository.findModelRunByIdempotencyKey(key);
			if (raced?.operation === 'GENERATE_CANDIDATES' && raced.normalizedEventVersionId === versionId) return raced.id;
			const completedAt = this.now();
			await this.repository.createModelRun({ id: runId, operation: 'GENERATE_CANDIDATES', status: 'FAILED',
				sourceIntakeId: intakeId, normalizedEventVersionId: versionId, provider: this.provider.providerId,
				model: this.provider.modelId, providerRevision: null, promptVersion: CANDIDATE_PROMPT_VERSION,
				inputHash: await sha256(`${CANDIDATE_PROMPT_VERSION}\n${inputText}`), outputHash: null,
				inputTokens: executed?.result.usage.inputTokens ?? null, outputTokens: executed?.result.usage.outputTokens ?? null, inputCharacters: inputText.length,
				outputCharacters: executed?.result.usage.outputCharacters ?? 0, latencyMs: error instanceof ModelExecutionError ? error.latencyMs : executed?.latencyMs ?? 0,
				retryCount: error instanceof ModelExecutionError ? error.retryCount : executed?.retryCount ?? 0,
				estimatedCostMicrousd: executed?.result.usage.estimatedCostMicrousd ?? reservedCostMicrousd,
				candidateCount: 0, idempotencyKey: key, requestedByEmail,
				failureClassification: sanitizedFailure(error), ...persistedProviderDiagnostics(error), createdAt, completedAt });
			throw editorialModelFailure(error);
		}
	}

	async generateArticleBody(identity: EditorialIdentity, input: Record<string, unknown>): Promise<string> {
		const requestedByEmail = actor(identity);
		if (!this.generationEnabled) {
			throw new EditorialValidationError('Model generation is disabled or is not configured.', 'model-disabled');
		}
		const candidateId = requiredText(input.candidateId, 'Candidate ID', 100);
		const key = idempotencyKey(input.idempotencyKey);
		const existing = await this.repository.findArticleBodyRunByIdempotencyKey(key);
		if (existing) {
			if (existing.candidateId !== candidateId) {
				throw new EditorialValidationError('The idempotency key belongs to another operation.');
			}
			if (existing.status === 'SUCCEEDED') return existing.id;
			if (existing.status === 'PENDING') {
				throw new EditorialValidationError('Article body generation is already in progress.', 'conflict');
			}
			throw new EditorialValidationError('The prior article body request failed. Reload to retry.', 'operation-failed');
		}

		const context = await this.repository.findCandidateForBodyGeneration(candidateId);
		if (!context) throw new EditorialValidationError('The candidate or its source intake was not found.', 'not-found');
		const { candidate, intake, version } = context;
		if (candidate.status !== 'DRAFT') throw new EditorialValidationError('Only a DRAFT candidate may generate an article body.');
		if (candidate.draftBodyMarkdown.trim()) throw new EditorialValidationError('The candidate already has an article body.', 'conflict');
		if (candidate.bodyGenerationState === 'PENDING') throw new EditorialValidationError('Article body generation is already in progress.', 'conflict');
		if (intake.references.length === 0) throw new EditorialValidationError('At least one source reference is required.');
		if (!candidate.normalizedEventVersionId || !version
			|| version.id !== candidate.normalizedEventVersionId
			|| version.sourceIntakeId !== intake.id
			|| version.reviewState !== 'ACCEPTED') {
			throw new EditorialValidationError('An accepted normalized-event version is required.');
		}
		if (!intake.assessmentReviewedAt || !['SUITABLE', 'SENSITIVE'].includes(intake.satireSuitability)) {
			throw new EditorialValidationError('The source suitability must be reviewed before body generation.');
		}
		const facts = version.assertions.filter((assertion) => assertion.kind === 'FACT');
		if (facts.length === 0 || facts.some((assertion) => !hasAuthoritativeFactSupport(assertion, intake.references))) {
			throw new EditorialValidationError('Every generated article requires authoritative factual support.');
		}
		const sensitive = intake.satireSuitability === 'SENSITIVE';
		const cautionReason = sensitive ? candidate.editorialNotes.trim() || null : null;
		if (sensitive && !cautionReason) {
			throw new EditorialValidationError('Sensitive-source body generation requires a persisted editorial caution reason.');
		}

		const modelInput: GenerateArticleBodyInput = {
			source: {
				title: intake.title, neutralBrief: intake.neutralBrief,
				significanceScore: intake.significanceScore, satirePotentialScore: intake.satirePotentialScore,
				satireSuitability: intake.satireSuitability, suitabilityReason: intake.suitabilityReason,
				guardrailFlags: intake.guardrailFlags, editorialNotes: intake.editorialNotes,
				references: intake.references.map((reference) => ({
					id: reference.id, sourceTitle: reference.sourceTitle, sourceUrl: reference.sourceUrl,
					publisherName: reference.publisherName, sourceTier: reference.sourceTier,
					sourceType: reference.sourceType, publishedAt: reference.publishedAt,
				})),
			},
			normalizedEvent: {
				id: version.id, eventStatement: version.eventStatement,
				proposedSuitability: version.proposedSuitability,
				suitabilityReason: version.suitabilityReason,
				guardrailFlags: version.guardrailFlags,
				assertions: version.assertions.map(({ id, kind, statement, sources }) => ({ id, kind, statement, sources })),
				reviewReason: version.reviewReason,
			},
			candidate: {
				headline: candidate.proposedHeadline, deck: candidate.proposedDeck,
				rationale: candidate.rationale, satiricalMechanism: candidate.satiricalMechanism,
				category: candidate.categoryName, editorialNotes: candidate.editorialNotes,
			},
			governance: {
				sensitive,
				unresolvedAllegation: intake.guardrailFlags.includes('UNRESOLVED_ALLEGATION')
					|| version.guardrailFlags.includes('UNRESOLVED_ALLEGATION'),
				editorialCautionReason: cautionReason,
			},
		};
		const inputText = JSON.stringify(modelInput);
		const createdAt = this.now();
		const reservedCostMicrousd = await this.requireBudget('GENERATE_ARTICLE_BODY', inputText.length, createdAt);
		const runId = this.createId();
		const claimed = await this.repository.claimArticleBodyGeneration({
			id: runId, candidateId, sourceIntakeId: intake.id, normalizedEventVersionId: version.id,
			provider: this.provider.providerId, model: this.provider.modelId,
			promptVersion: ARTICLE_BODY_PROMPT_VERSION,
			inputHash: await sha256(`${ARTICLE_BODY_PROMPT_VERSION}\n${inputText}`),
			inputCharacters: inputText.length, estimatedCostMicrousd: reservedCostMicrousd,
			idempotencyKey: key, requestedByEmail, sourceWasSensitive: sensitive,
			cautionReason, createdAt, auditId: this.createId(),
		});
		if (!claimed) {
			throw new EditorialValidationError('The candidate changed or body generation is already in progress.', 'conflict');
		}

		let executed: { result: ModelResult<unknown>; retryCount: number; latencyMs: number } | null = null;
		try {
			executed = await runWithLimits(
				(signal) => this.provider.generateArticleBody(modelInput, signal),
				inputText.length,
				modelLimitsForOperation('GENERATE_ARTICLE_BODY', this.limits),
			);
			const proposal = parseArticleBodyProposal(executed.result.output);
			const acceptedFactIds = new Set(facts.map((fact) => fact.id));
			if (proposal.factualAssertionIdsUsed.length === 0) {
				throw new ArticleBodyFactValidationError('MALFORMED_OUTPUT_FACT_IDS_EMPTY');
			}
			if (new Set(proposal.factualAssertionIdsUsed).size !== proposal.factualAssertionIdsUsed.length) {
				throw new ArticleBodyFactValidationError('MALFORMED_OUTPUT_FACT_ID_DUPLICATE');
			}
			if (proposal.factualAssertionIdsUsed.some((assertionId) => !acceptedFactIds.has(assertionId))) {
				throw new ArticleBodyFactValidationError('MALFORMED_OUTPUT_FACT_ID_NOT_ACCEPTED');
			}
			const outputText = JSON.stringify(proposal);
			const completedAt = this.now();
			const run = await this.runRecord({
				id: runId, operation: 'GENERATE_ARTICLE_BODY', sourceIntakeId: intake.id,
				normalizedEventVersionId: version.id, key, requestedByEmail, createdAt, completedAt,
				promptVersion: ARTICLE_BODY_PROMPT_VERSION, inputText, outputText, executed,
			});
			const completed = await this.repository.completeArticleBodyGeneration({
				run, candidateId, bodyMarkdown: proposal.bodyMarkdown, actorEmail: requestedByEmail,
				completedAt, auditId: this.createId(),
			});
			if (!completed) {
				await this.repository.failArticleBodyGeneration({
					runId, candidateId, providerRevision: run.providerRevision,
					inputTokens: run.inputTokens, outputTokens: run.outputTokens,
					outputCharacters: run.outputCharacters, latencyMs: run.latencyMs,
					estimatedCostMicrousd: run.estimatedCostMicrousd,
					failureClassification: 'CONCURRENT_EDIT', providerHttpStatus: null,
					providerErrorType: null, providerErrorCode: null, providerErrorMessage: null,
					providerRequestId: run.providerRequestId, providerRetryAfter: null,
					actorEmail: requestedByEmail, completedAt, auditId: this.createId(),
				});
				throw new EditorialValidationError('The candidate changed while its body was being generated.', 'conflict');
			}
			return runId;
		} catch (error) {
			if (error instanceof EditorialValidationError && error.code === 'conflict') throw error;
			const completedAt = this.now();
			const diagnostics = persistedProviderDiagnostics(error);
			await this.repository.failArticleBodyGeneration({
				runId, candidateId, providerRevision: executed?.result.providerRevision ?? null,
				inputTokens: executed?.result.usage.inputTokens ?? null,
				outputTokens: executed?.result.usage.outputTokens ?? null,
				outputCharacters: executed?.result.usage.outputCharacters ?? 0,
				latencyMs: error instanceof ModelExecutionError ? error.latencyMs : executed?.latencyMs ?? 0,
				estimatedCostMicrousd: executed?.result.usage.estimatedCostMicrousd ?? reservedCostMicrousd,
				failureClassification: sanitizedFailure(error), ...diagnostics,
				providerErrorMessage: null,
				providerRequestId: diagnostics.providerRequestId ?? executed?.result.providerRequestId ?? null,
				actorEmail: requestedByEmail, completedAt, auditId: this.createId(),
			});
			throw editorialModelFailure(error);
		}
	}

	async resolveStaleArticleBodyGeneration(identity: EditorialIdentity, input: Record<string, unknown>): Promise<void> {
		const actorEmail = actor(identity);
		const candidateId = requiredText(input.candidateId, 'Candidate ID', 100);
		const context = await this.repository.findCandidateForBodyGeneration(candidateId);
		if (!context || context.candidate.bodyGenerationState !== 'PENDING'
			|| !context.candidate.bodyGenerationRunId) {
			throw new EditorialValidationError('The article-body request is not pending.', 'conflict');
		}
		const resolvedAt = this.now();
		const resolvedAtMs = Date.parse(resolvedAt);
		if (!Number.isFinite(resolvedAtMs)) throw new EditorialValidationError('The current time is invalid.');
		const staleBefore = new Date(resolvedAtMs - STALE_BODY_GENERATION_MINIMUM_MS).toISOString();
		const resolved = await this.repository.resolveStaleArticleBodyGeneration({
			runId: context.candidate.bodyGenerationRunId, candidateId, actorEmail,
			staleBefore, resolvedAt, auditId: this.createId(),
		});
		if (!resolved) {
			throw new EditorialValidationError('A pending article-body request can be resolved only after one hour.', 'conflict');
		}
	}

	private async requireBudget(operation: ModelOperation, inputCharacters: number, requestedAt: string): Promise<number> {
		const reserved = this.provider.estimateMaximumCostMicrousd(operation, inputCharacters);
		if (!Number.isSafeInteger(reserved) || reserved < 0 || reserved > this.limits.maxEstimatedCostMicrousd) {
			throw new EditorialValidationError('The model request exceeds its configured cost limit.', 'model-budget');
		}
		const dayStart = `${requestedAt.slice(0, 10)}T00:00:00.000Z`;
		const spent = await this.repository.sumModelRunCostSince(dayStart);
		if (!Number.isSafeInteger(spent) || spent < 0 || spent + reserved > this.dailyBudgetMicrousd) {
			throw new EditorialValidationError('The daily model budget would be exceeded.', 'model-budget');
		}
		return reserved;
	}

	private async runRecord(input: {
		id: string; operation: ModelRunRecord['operation']; sourceIntakeId: string;
		normalizedEventVersionId: string | null; key: string; requestedByEmail: string;
		createdAt: string; completedAt: string; promptVersion: string; inputText: string; outputText: string;
		executed: { result: ModelResult<unknown>; retryCount: number; latencyMs: number };
	}): Promise<ModelRunRecord> {
		return { id: input.id, operation: input.operation, status: 'SUCCEEDED',
			sourceIntakeId: input.sourceIntakeId, normalizedEventVersionId: input.normalizedEventVersionId,
			provider: input.executed.result.provider, model: input.executed.result.model,
			providerRevision: input.executed.result.providerRevision, promptVersion: input.promptVersion,
			inputHash: await sha256(`${input.promptVersion}\n${input.inputText}`), outputHash: await sha256(input.outputText),
			inputTokens: input.executed.result.usage.inputTokens,
			outputTokens: input.executed.result.usage.outputTokens,
			inputCharacters: input.executed.result.usage.inputCharacters,
			outputCharacters: input.executed.result.usage.outputCharacters,
			latencyMs: input.executed.latencyMs, retryCount: input.executed.retryCount,
			estimatedCostMicrousd: input.executed.result.usage.estimatedCostMicrousd,
			candidateCount: input.operation === 'GENERATE_CANDIDATES' ? this.limits.defaultCandidateCount : 0,
			idempotencyKey: input.key, requestedByEmail: input.requestedByEmail,
			failureClassification: null, providerHttpStatus: null, providerErrorType: null,
			providerErrorCode: null, providerErrorMessage: null,
			providerRequestId: input.executed.result.providerRequestId ?? null,
			providerRetryAfter: null, createdAt: input.createdAt, completedAt: input.completedAt };
	}
}
