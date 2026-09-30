import type { EditorialWorkflowRepository } from '../data/editorial-workflow-repository';
import type { EditorialBatchItem } from '../domain/editorial-workflow';
import type { EditorialIdentity } from '../domain/editorial';
import { EditorialValidationError, requiredText } from './validation';

export interface WorkflowPipelinePort {
	advance(item: EditorialBatchItem): Promise<{ storyId: string; ready: boolean }>;
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

	constructor(
		private readonly repository: EditorialWorkflowRepository,
		private readonly pipeline?: WorkflowPipelinePort,
		private readonly images?: FinalReviewImagePort,
		dependencies: { now?: () => string; createId?: () => string } = {},
	) {
		this.now = dependencies.now ?? (() => new Date().toISOString());
		this.createId = dependencies.createId ?? (() => crypto.randomUUID());
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

	async process(limit = 3): Promise<{ ready: number; pending: number; failed: number }> {
		if (!this.pipeline) throw new Error('Workflow pipeline is not configured.');
		const report = { ready: 0, pending: 0, failed: 0 };
		const touchedBatches = new Set<string>();
		for (let item of await this.repository.listProcessable(limit)) {
			touchedBatches.add(item.batchId);
			if (item.state === 'SELECTED') {
				const at = this.now();
				if (!(await this.repository.markGenerating(item.batchId, item.intakeId, at, this.createId()))) continue;
				item = { ...item, state: 'GENERATING', updatedAt: at };
			}
			try {
				const result = await this.pipeline.advance(item);
				if (result.ready) {
					if (await this.repository.markReady(item.batchId, item.intakeId, result.storyId, this.now(), this.createId())) report.ready += 1;
				} else report.pending += 1;
			} catch (error) {
				await this.repository.markFailed(item.batchId, item.intakeId, 'AUTOMATIC_GENERATION', boundedFailure(error), this.now(), this.createId());
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
