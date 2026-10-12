import type { EditorialWorkflowRepository } from '../data/editorial-workflow-repository';
import type { EditorialIdentity } from '../domain/editorial';
import { isSmokeTargetPair, type EditorialSmokeTarget } from './editorial-smoke-target';
import { EditorialValidationError, requiredText } from './validation';

export class CandidateSelectionService {
	private readonly now: () => string;
	private readonly createId: () => string;

	constructor(
		private readonly repository: EditorialWorkflowRepository,
		private readonly smokeTarget: EditorialSmokeTarget | null,
		dependencies: { now?: () => string; createId?: () => string } = {},
	) {
		this.now = dependencies.now ?? (() => new Date().toISOString());
		this.createId = dependencies.createId ?? (() => crypto.randomUUID());
	}

	async select(identity: EditorialIdentity | null | undefined, input: Record<string, unknown>): Promise<'SELECTED' | 'UNCHANGED' | 'CHANGED'> {
		const actorEmail = identity?.email?.trim().toLowerCase();
		if (!actorEmail) throw new EditorialValidationError('An authenticated editor is required.', 'unauthorized');
		const batchId = requiredText(input.batchId, 'Batch ID', 100);
		const intakeId = requiredText(input.intakeId, 'Intake ID', 100);
		const normalizedEventVersionId = requiredText(input.normalizedEventVersionId, 'Normalized event version ID', 100);
		const candidateId = requiredText(input.candidateId, 'Candidate ID', 100);
		const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 2000) : null;
		if (!isSmokeTargetPair(this.smokeTarget, batchId, intakeId)) {
			throw new EditorialValidationError('Candidate selection is outside the configured smoke target.', 'conflict');
		}
		const before = await this.repository.findCandidateSelection(batchId, intakeId);
		if (before && before.candidateId !== candidateId && !reason) {
			throw new EditorialValidationError('A reason is required to change the selected candidate.', 'conflict');
		}
		const selection = await this.repository.selectCandidate({
			id: this.createId(), batchId, intakeId, normalizedEventVersionId, candidateId,
			actorEmail, at: this.now(), reason,
		});
		if (!selection) {
			throw new EditorialValidationError('Candidate is not eligible, does not belong to this accepted normalization, or body generation has begun.', 'conflict');
		}
		if (before?.candidateId === candidateId) return 'UNCHANGED';
		return before ? 'CHANGED' : 'SELECTED';
	}
}
