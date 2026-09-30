import { handle } from '@astrojs/cloudflare/handler';
import { runRuntimeAutomation, type AutomationEnvironment } from './automation/runtime-automation';
import { runEditorialReviewReminders, type ReviewReminderEnvironment } from './reminders/runtime-editorial-review-reminders';
import { runEditorialWorkflow } from './services/runtime-editorial-workflow';

const REVIEW_REMINDER_CRON = '*/5 * * * *';

export default {
	fetch(request, environment, context) {
		return handle(request, environment, context);
	},
	async scheduled(controller, environment) {
		controller.noRetry();
		if (controller.cron === REVIEW_REMINDER_CRON) {
			await runEditorialWorkflow();
			await runEditorialReviewReminders(environment as ReviewReminderEnvironment);
			return;
		}
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
		await runEditorialWorkflow();
		await runEditorialReviewReminders(environment as ReviewReminderEnvironment);
	},
} satisfies ExportedHandler<Env>;
