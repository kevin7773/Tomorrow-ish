import type { APIRoute } from 'astro';
import { getEditorialRepository } from '../../../data/runtime-editorial-repository';
import {
	actionErrorResponse,
	formRecord,
	redirectWithResult,
	requireEditor,
	safeReturnPath,
} from '../../../lib/editorial-actions';
import { EditorialService } from '../../../services/editorial-service';

export const POST: APIRoute = async (context) => {
	const form = await context.request.formData();
	const returnPath = safeReturnPath(form.get('returnPath'), '/editorial/history');
	const service = new EditorialService(getEditorialRepository());

	try {
		const identity = requireEditor(context);
		const input = formRecord(form);
		switch (form.get('action')) {
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
		return actionErrorResponse(error, returnPath);
	}
};
