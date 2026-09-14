import type { EditorialIdentity } from '../domain/editorial';
import type { EditorialService } from '../services/editorial-service';
import { EditorialValidationError } from '../services/validation';
import {
	actionErrorResponse,
	formRecord,
	redirectWithResult,
	safeReturnPath,
} from './editorial-actions';

type ArchiveService = Pick<
	EditorialService,
	| 'archiveUnsuitableIntake'
	| 'restoreIntake'
	| 'archiveRejectedCandidate'
	| 'restoreCandidate'
	| 'archiveAllUnsuitableIntakes'
	| 'archiveAllRejectedCandidates'
>;

const BULK_ARCHIVE_ACTIONS = new Set([
	'archive-all-unsuitable-intakes',
	'archive-all-rejected-candidates',
]);

export function archiveMutationSecurityFailureResponse(pathname: string, method: string): Response | null {
	if (method !== 'POST' || pathname !== '/editorial/actions/archive') return null;
	return redirectWithResult('/editorial/history', 'error', 'archive-request-verification-failed');
}

export async function handleEditorialArchiveAction(
	form: FormData,
	identity: EditorialIdentity,
	service: ArchiveService,
): Promise<Response> {
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/history');
	const action = form.get('action');
	const input = formRecord(form);

	try {
		switch (action) {
			case 'archive-unsuitable-intake':
				await service.archiveUnsuitableIntake(identity, input);
				return redirectWithResult(returnPath, 'message', 'intake-archived');
			case 'restore-intake':
				await service.restoreIntake(identity, input);
				return redirectWithResult(returnPath, 'message', 'intake-restored');
			case 'archive-rejected-candidate':
				await service.archiveRejectedCandidate(identity, input);
				return redirectWithResult(returnPath, 'message', 'candidate-archived');
			case 'restore-candidate':
				await service.restoreCandidate(identity, input);
				return redirectWithResult(returnPath, 'message', 'candidate-restored');
			case 'archive-all-unsuitable-intakes': {
				const count = await service.archiveAllUnsuitableIntakes(identity, input);
				return redirectWithResult(returnPath, 'message', 'intakes-bulk-archived', { count: String(count) });
			}
			case 'archive-all-rejected-candidates': {
				const count = await service.archiveAllRejectedCandidates(identity, input);
				return redirectWithResult(returnPath, 'message', 'candidates-bulk-archived', { count: String(count) });
			}
			default:
				return redirectWithResult(returnPath, 'error', 'invalid-request');
		}
	} catch (error) {
		if (typeof action === 'string' && BULK_ARCHIVE_ACTIONS.has(action)) {
			if (error instanceof EditorialValidationError && error.code === 'conflict') {
				return redirectWithResult(returnPath, 'error', 'archive-preview-stale');
			}
			if (!(error instanceof EditorialValidationError)) {
				console.error('Editorial bulk archive failed', {
					action,
					failureType: error instanceof Error ? error.name : 'UnknownError',
				});
				return redirectWithResult(returnPath, 'error', 'archive-operation-failed');
			}
		}
		return actionErrorResponse(error, returnPath);
	}
}
