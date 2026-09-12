import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { runRuntimeAutomation, type AutomationEnvironment } from '../../../automation/runtime-automation';
import { requireEditor } from '../../../lib/editorial-actions';

export const POST: APIRoute = async (context) => {
	const identity = requireEditor(context);
	const form = await context.request.formData();
	const dryRun = form.get('mode') === 'dry-run';
	const requestedCap = Number(form.get('maxItems'));
	const report = await runRuntimeAutomation(env as AutomationEnvironment, {
		trigger: 'MANUAL',
		dryRun,
		...(Number.isFinite(requestedCap) ? { maxItems: requestedCap } : {}),
	}, identity.email);
	return Response.json(report, { headers: { 'Cache-Control': 'private, no-store' } });
};
