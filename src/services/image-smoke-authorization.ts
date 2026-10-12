import type { EditorialWorkflowRepository } from '../data/editorial-workflow-repository';
import type { EditorialSmokeTarget } from './editorial-smoke-target';

export async function authorizeImageSmokeTarget(
	repository: EditorialWorkflowRepository,
	target: EditorialSmokeTarget,
): Promise<boolean> {
	if (!target.storyId || !target.candidateId || !target.normalizedEventVersionId) return false;
	const [item, selection, accepted] = await Promise.all([
		repository.findItem(target.batchId, target.intakeId),
		repository.findCandidateSelection(target.batchId, target.intakeId),
		repository.isAcceptedNormalization(target.normalizedEventVersionId, target.intakeId),
	]);
	return accepted && item?.batchId === target.batchId
		&& item.intakeId === target.intakeId
		&& item.storyId === target.storyId
		&& item.candidateId === target.candidateId
		&& selection?.batchId === target.batchId
		&& selection.intakeId === target.intakeId
		&& selection.candidateId === target.candidateId
		&& selection.normalizedEventVersionId === target.normalizedEventVersionId;
}
