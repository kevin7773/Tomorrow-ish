import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	createCronConfiguration,
	readJson,
	validateBaselineTransition,
	validateGeneratedConfiguration,
} from './release-safety.mjs';

function option(name, fallback = null) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

const stages = new Set(['disabled', 'notifications', 'generation-acceptance', 'publication', 'routine']);
const generationGates = [
	'MODEL_BUDGET_ADMISSION_ENABLED',
	'MODEL_GENERATION_ENABLED',
	'EDITORIAL_WORKFLOW_GENERATION_ENABLED',
	'EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED',
	'IMAGE_GENERATION_ENABLED',
];
const allGates = [...generationGates, 'EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED',
	'EDITORIAL_AUTOMATED_PUBLICATION_ENABLED'];

function requireStage(name, value) {
	if (!stages.has(value)) throw new Error(`${name} must name a reviewed automation stage`);
	return value;
}

function explicitUtc(value) {
	return typeof value === 'string'
		&& /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
		&& Number.isFinite(Date.parse(value));
}

function stageVars(base, stage, notBefore) {
	const vars = structuredClone(base);
	for (const gate of allGates) vars[gate] = 'false';
	delete vars.EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE;
	if (stage !== 'disabled') vars.EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED = 'true';
	if (['generation-acceptance', 'routine'].includes(stage)) {
		if (!explicitUtc(notBefore)) throw new Error(`${stage} requires --not-before as an explicit UTC timestamp`);
		for (const gate of generationGates) vars[gate] = 'true';
		vars.EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE = notBefore;
	}
	if (['publication', 'routine'].includes(stage)) vars.EDITORIAL_AUTOMATED_PUBLICATION_ENABLED = 'true';
	return vars;
}

function exactChanges(previous, target) {
	const result = {};
	for (const name of [...new Set([...Object.keys(previous), ...Object.keys(target)])].sort()) {
		const from = Object.hasOwn(previous, name) ? previous[name] : null;
		const to = Object.hasOwn(target, name) ? target[name] : null;
		if (from !== to) result[name] = { from, to };
	}
	return result;
}

const fromStage = requireStage('--from', option('--from', 'disabled'));
const toStage = requireStage('--to', option('--to'));
const notBefore = option('--not-before');
const serverDirectory = resolve(option('--server-dir', 'dist/server'));
const privateDirectory = resolve(option('--private-dir', '.release/private/automation-transition'));
const canonicalBaseline = await readJson(resolve('release/production-baseline.json'));
const canonicalConfig = await readJson(resolve(serverDirectory, 'wrangler.json'));

const previousBaseline = structuredClone(canonicalBaseline);
previousBaseline.requiredVars = stageVars(canonicalBaseline.requiredVars, fromStage, notBefore);
const targetBaseline = structuredClone(canonicalBaseline);
targetBaseline.requiredVars = stageVars(canonicalBaseline.requiredVars, toStage, notBefore);
const contract = {
	name: `production-automation-${fromStage}-to-${toStage}`,
	automationCapabilityTransition: { from: fromStage, to: toStage },
	allowedVariableChanges: exactChanges(previousBaseline.requiredVars, targetBaseline.requiredVars),
};
const transition = validateBaselineTransition(previousBaseline, targetBaseline, contract);
const automationPolicy = transition.automationCapabilities.target;
const targetConfig = structuredClone(canonicalConfig);
targetConfig.vars = structuredClone(targetBaseline.requiredVars);
validateGeneratedConfiguration(targetConfig, targetBaseline, { automationCapabilities: automationPolicy });
const pausedConfig = createCronConfiguration(targetConfig, targetBaseline, true,
	{ automationCapabilities: automationPolicy });
const restoredConfig = createCronConfiguration(targetConfig, targetBaseline, false,
	{ automationCapabilities: automationPolicy });

await mkdir(privateDirectory, { recursive: true });
await Promise.all([
	writeFile(resolve(privateDirectory, 'production-baseline.previous.json'),
		`${JSON.stringify(previousBaseline, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
	writeFile(resolve(privateDirectory, 'production-baseline.target.json'),
		`${JSON.stringify(targetBaseline, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
	writeFile(resolve(privateDirectory, 'transition-contract.json'),
		`${JSON.stringify(contract, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
	writeFile(resolve(serverDirectory, 'wrangler.automation.json'),
		`${JSON.stringify(targetConfig, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
	writeFile(resolve(serverDirectory, 'wrangler.automation.pause.json'),
		`${JSON.stringify(pausedConfig, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
	writeFile(resolve(serverDirectory, 'wrangler.automation.restore.json'),
		`${JSON.stringify(restoredConfig, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
	writeFile(resolve(privateDirectory, 'preparation-summary.json'), `${JSON.stringify({
		ok: true,
		from: fromStage,
		to: toStage,
		routineGenerationNotBefore: transition.automationCapabilities.target.routineGenerationNotBefore,
		changedVariables: transition.changedVariables,
	}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
]);

process.stdout.write(`${JSON.stringify({ ok: true, from: fromStage, to: toStage,
	privateDirectory, serverDirectory })}\n`);
