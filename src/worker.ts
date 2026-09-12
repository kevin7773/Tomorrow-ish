import { handle } from '@astrojs/cloudflare/handler';
import { runRuntimeAutomation, type AutomationEnvironment } from './automation/runtime-automation';

export default {
	fetch(request, environment, context) {
		return handle(request, environment, context);
	},
	async scheduled(controller, environment) {
		controller.noRetry();
		const report = await runRuntimeAutomation(environment as AutomationEnvironment, {
			trigger: 'SCHEDULED',
			dryRun: false,
		});
		console.log('[intake-automation] scheduled run completed', {
			runId: report.runId,
			status: report.status,
			discoveredCount: report.discoveredCount,
			processedCount: report.processedCount,
			intakeCount: report.intakeCount,
			generatedCount: report.generatedCount,
			skippedCount: report.skippedCount,
			failedCount: report.failedCount,
		});
	},
} satisfies ExportedHandler<Env>;
