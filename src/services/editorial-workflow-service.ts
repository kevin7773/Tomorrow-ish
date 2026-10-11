import type { EditorialWorkflowRepository } from '../data/editorial-workflow-repository';
import type { EditorialBatchItem } from '../domain/editorial-workflow';
import type { EditorialIdentity } from '../domain/editorial';
import { EditorialValidationError, requiredText } from './validation';

export interface WorkflowPipelinePort {
	advance(item: EditorialBatchItem, guard?: { renew(): Promise<void> }): Promise<{ storyId: string; ready: boolean }>;
}

export interface FinalReviewImagePort {
	approveLatestGenerated(storyId: string, identity: EditorialIdentity): Promise<void>;
	regenerate(storyId: string, identity: EditorialIdentity): Promise<void>;
}

function email(identity: EditorialIdentity | null | undefined): string {
	if (!identity?.email) throw new EditorialValidationError('An authenticated editor is required.', 'unauthorized');
	return identity.email.trim().toLowerCase();
}

function boundedFailure(error: unknown): string {
	if (error instanceof EditorialValidationError) return error.code.toUpperCase().replaceAll('-', '_');
	return 'PIPELINE_FAILURE';
}

export class EditorialWorkflowService {
	private readonly now: () => string;
	private readonly createId: () => string;
	private readonly leaseMs: number;
	private readonly generationEnabled: boolean;
	private readonly owner: () => string;
	private readonly smokeTarget: { batchId: string; intakeId: string } | null;

	constructor(
		private readonly repository: EditorialWorkflowRepository,
		private readonly pipeline?: WorkflowPipelinePort,
		private readonly images?: FinalReviewImagePort,
		dependencies: { now?: () => string; createId?: () => string; leaseMs?: number; generationEnabled?: boolean; owner?: () => string; smokeTarget?: { batchId: string; intakeId: string } | null } = {},
	) {
		this.now = dependencies.now ?? (() => new Date().toISOString());
		this.createId = dependencies.createId ?? (() => crypto.randomUUID());
		this.leaseMs = dependencies.leaseMs ?? 10 * 60 * 1_000;
		this.generationEnabled = dependencies.generationEnabled ?? false;
		this.owner = dependencies.owner ?? (() => `workflow:${crypto.randomUUID()}`);
		this.smokeTarget = dependencies.smokeTarget ?? null;
	}

	async triage(identity: EditorialIdentity, batchIdValue: unknown, intakeIds: unknown[], decision: 'SELECT' | 'REJECT'): Promise<number> {
		const actor = email(identity);
		const batchId = requiredText(batchIdValue, 'Batch ID', 100);
		const ids = [...new Set(intakeIds.map((value) => requiredText(value, 'Intake ID', 100)))];
		if (ids.length === 0) throw new EditorialValidationError('Select at least one intake.');
		let changed = 0;
		for (const intakeId of ids) {
			const at = this.now();
			const result = decision === 'SELECT'
				? await this.repository.select(batchId, intakeId, actor, at, this.createId())
				: await this.repository.rejectIntake(batchId, intakeId, actor, at, this.createId());
			if (result) changed += 1;
		}
		if (changed === 0) throw new EditorialValidationError('The selected intakes were already triaged.', 'conflict');
		return changed;
	}

	async process(limit = 3): Promise<{ reconciled: number; ready: number; pending: number; failed: number }> {
		const at = this.now();
		const report = { reconciled: await this.repository.reconcilePublished({
			limit: Math.max(limit * 10, 50), actorEmail: 'automation@tomorrow-ish.news', at,
			createEventId: this.createId, createAuditId: this.createId,
		}), ready: 0, pending: 0, failed: 0 };
		if (!this.generationEnabled || !this.smokeTarget) return report;
		if (!this.pipeline) throw new Error('Workflow pipeline is not configured.');
		const touchedBatches = new Set<string>();
		const owner = this.owner();
		const leaseExpiresAt = new Date(new Date(at).getTime() + this.leaseMs).toISOString();
		for (const item of await this.repository.claimProcessable({ limit: 1, owner, at, leaseExpiresAt, createEventId: this.createId, target: this.smokeTarget })) {
			touchedBatches.add(item.batchId);
			try {
				const renew = async () => {
					const renewedAt = this.now();
					const renewedUntil = new Date(new Date(renewedAt).getTime() + this.leaseMs).toISOString();
					if (!this.repository.renewLease || !(await this.repository.renewLease(item.batchId, item.intakeId, owner, renewedAt, renewedUntil))) {
						throw new Error('WORKFLOW_LEASE_LOST');
					}
				};
				const result = await this.pipeline.advance(item, { renew });
				if (result.ready) {
					if (await this.repository.markReady(item.batchId, item.intakeId, result.storyId, owner, this.now(), this.createId())) report.ready += 1;
				} else {
					await this.repository.releaseLease(item.batchId, item.intakeId, owner, this.now());
					report.pending += 1;
				}
			} catch (error) {
				await this.repository.markFailed(item.batchId, item.intakeId, owner, 'AUTOMATIC_GENERATION', boundedFailure(error), this.now(), this.createId());
				report.failed += 1;
			}
		}
		for (const batchId of touchedBatches) await this.repository.ensureFinalReminder(batchId, this.now(), this.createId());
		return report;
	}

	async retry(identity: EditorialIdentity, batchIdValue: unknown, intakeIdValue: unknown): Promise<void> {
		const batchId = requiredText(batchIdValue, 'Batch ID', 100);
		const intakeId = requiredText(intakeIdValue, 'Intake ID', 100);
		if (!(await this.repository.retryFailed(batchId, intakeId, email(identity), this.now(), this.createId()))) {
			throw new EditorialValidationError('Only a failed workflow item can be retried.', 'conflict');
		}
	}

	async publish(identity: EditorialIdentity, batchIdValue: unknown, intakeIdValue: unknown, confirmation: unknown): Promise<void> {
		if (confirmation !== 'PUBLISH') throw new EditorialValidationError('Type PUBLISH to confirm publication.');
		if (!this.images) throw new Error('Final-review image operations are not configured.');
		const batchId = requiredText(batchIdValue, 'Batch ID', 100);
		const intakeId = requiredText(intakeIdValue, 'Intake ID', 100);
		const item = await this.repository.findItem(batchId, intakeId);
		if (!item?.storyId || item.state !== 'READY_FOR_REVIEW') throw new EditorialValidationError('The article is not ready for final review.', 'conflict');
		await this.images.approveLatestGenerated(item.storyId, identity);
		const at = this.now();
		if (!(await this.repository.publishFinal({ batchId, intakeId, storyId: item.storyId,
			actorEmail: email(identity), at, eventId: this.createId(), auditId: this.createId() }))) {
			throw new EditorialValidationError('The article changed; reload before publishing.', 'conflict');
		}
	}

	async reject(identity: EditorialIdentity, batchIdValue: unknown, intakeIdValue: unknown, confirmation: unknown): Promise<void> {
		if (confirmation !== 'REJECT') throw new EditorialValidationError('Type REJECT to confirm rejection.');
		const batchId = requiredText(batchIdValue, 'Batch ID', 100);
		const intakeId = requiredText(intakeIdValue, 'Intake ID', 100);
		const item = await this.repository.findItem(batchId, intakeId);
		if (!item?.storyId || item.state !== 'READY_FOR_REVIEW') throw new EditorialValidationError('The article is not ready for final review.', 'conflict');
		const at = this.now();
		if (!(await this.repository.rejectFinal({ batchId, intakeId, storyId: item.storyId,
			actorEmail: email(identity), at, eventId: this.createId(), auditId: this.createId() }))) {
			throw new EditorialValidationError('The article changed; reload and retry.', 'conflict');
		}
	}

	async regenerateImage(identity: EditorialIdentity, batchIdValue: unknown, intakeIdValue: unknown): Promise<void> {
		if (!this.images) throw new Error('Final-review image operations are not configured.');
		const batchId = requiredText(batchIdValue, 'Batch ID', 100);
		const intakeId = requiredText(intakeIdValue, 'Intake ID', 100);
		const item = await this.repository.findItem(batchId, intakeId);
		if (!item?.storyId || item.state !== 'READY_FOR_REVIEW') throw new EditorialValidationError('The article is not ready for final review.', 'conflict');
		await this.images.regenerate(item.storyId, identity);
		await this.repository.recordEvent({ id: this.createId(), batchId, intakeId, storyId: item.storyId,
			kind: 'IMAGE_REGENERATED', at: this.now() });
	}

	async recordEdit(identity: EditorialIdentity, batchId: string, intakeId: string, storyId: string): Promise<void> {
		await this.repository.recordEvent({ id: this.createId(), batchId, intakeId, storyId,
			kind: 'ARTICLE_EDITED', detail: email(identity), at: this.now() });
	}
}
