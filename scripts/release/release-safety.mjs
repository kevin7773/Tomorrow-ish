import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { init, parse } from 'es-module-lexer';

export const LIVE_SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

export class ReleaseSafetyError extends Error {
	constructor(message, details = []) {
		super([message, ...details.map((detail) => `- ${detail}`)].join('\n'));
		this.name = 'ReleaseSafetyError';
		this.details = details;
	}
}

export async function readJson(path) {
	return JSON.parse(await readFile(path, 'utf8'));
}

function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
	}
	return value;
}

function same(left, right) {
	return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function check(errors, condition, message) {
	if (!condition) errors.push(message);
}

const MODEL_BUDGET_VARIABLES = [
	'MODEL_NORMALIZE_MAX_COST_MICRO_USD',
	'MODEL_CANDIDATES_MAX_COST_MICRO_USD',
	'MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD',
	'MODEL_ITEM_BUDGET_MICRO_USD',
	'MODEL_BATCH_BUDGET_MICRO_USD',
	'MODEL_DAILY_BUDGET_MICRO_USD',
];

const DISABLED_GATES = [
	'MODEL_GENERATION_ENABLED',
	'EDITORIAL_WORKFLOW_GENERATION_ENABLED',
	'EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED',
	'EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED',
	'EDITORIAL_AUTOMATED_PUBLICATION_ENABLED',
	'IMAGE_GENERATION_ENABLED',
];
const CAPABILITY_GATES = ['MODEL_BUDGET_ADMISSION_ENABLED', ...DISABLED_GATES];

const ROUTINE_GENERATION_NOT_BEFORE = 'EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE';
const GENERATION_GATES = [
	'MODEL_BUDGET_ADMISSION_ENABLED',
	'MODEL_GENERATION_ENABLED',
	'EDITORIAL_WORKFLOW_GENERATION_ENABLED',
	'EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED',
	'IMAGE_GENERATION_ENABLED',
];
const AUTOMATION_STAGES = new Set([
	'disabled', 'notifications', 'generation-acceptance', 'publication', 'routine',
]);
const AUTOMATION_TRANSITIONS = new Set([
	'disabled>notifications',
	'notifications>disabled',
	'notifications>generation-acceptance',
	'generation-acceptance>notifications',
	'generation-acceptance>publication',
	'generation-acceptance>disabled',
	'notifications>publication',
	'publication>notifications',
	'publication>routine',
	'publication>disabled',
	'notifications>routine',
	'routine>notifications',
	'routine>publication',
	'routine>disabled',
]);

const NOTIFICATION_ACCEPTANCE_GATE = 'EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED';
const NOTIFICATION_ACCEPTANCE_AUTHORIZATION = 'EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID';
const NOTIFICATION_ACCEPTANCE_PATTERN = /^[a-z0-9:_-]{16,200}$/;

function sha256(value) {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

function acceptanceMode(vars) {
	if (vars?.[NOTIFICATION_ACCEPTANCE_GATE] === 'false'
		&& vars?.[NOTIFICATION_ACCEPTANCE_AUTHORIZATION] === '') return 'disabled';
	if (vars?.[NOTIFICATION_ACCEPTANCE_GATE] === 'true'
		&& NOTIFICATION_ACCEPTANCE_PATTERN.test(vars?.[NOTIFICATION_ACCEPTANCE_AUTHORIZATION] ?? '')) return 'enabled';
	return 'invalid';
}

function validateAcceptanceConfiguration(errors, vars, policy) {
	const expectedMode = policy?.mode ?? 'disabled';
	check(errors, ['disabled', 'enabled'].includes(expectedMode), 'notification acceptance-test policy mode is invalid');
	check(errors, acceptanceMode(vars) === expectedMode,
		expectedMode === 'enabled'
			? 'notification acceptance-test gate and authorization are not the exact reviewed enabled pair'
			: 'notification acceptance-test gate must be false and authorization must be blank');
	if (expectedMode === 'enabled') {
		check(errors, typeof policy?.authorizationIdSha256 === 'string'
			&& /^[a-f0-9]{64}$/.test(policy.authorizationIdSha256),
		'notification acceptance-test policy requires a SHA-256 authorization fingerprint');
		const authorizationId = vars?.[NOTIFICATION_ACCEPTANCE_AUTHORIZATION];
		check(errors, typeof authorizationId === 'string'
			&& sha256(authorizationId) === policy?.authorizationIdSha256,
		'notification acceptance-test authorization does not match the reviewed fingerprint');
	}
}

function reviewedTransitionValue(errors, name, expected, actual, side) {
	const exactKey = side;
	const hashKey = `${side}Sha256`;
	const hasExact = Object.hasOwn(expected ?? {}, exactKey);
	const hasHash = Object.hasOwn(expected ?? {}, hashKey);
	check(errors, hasExact !== hasHash, `${name} must review exactly one ${side} value or ${side} fingerprint`);
	if (hasExact) check(errors, expected[exactKey] === actual,
		`${name} does not match its reviewed from/to values (${side})`);
	if (hasHash) {
		check(errors, typeof actual === 'string' && NOTIFICATION_ACCEPTANCE_PATTERN.test(actual),
			`${name} ${side} value is not a valid one-use authorization`);
		check(errors, typeof expected[hashKey] === 'string' && /^[a-f0-9]{64}$/.test(expected[hashKey])
			&& typeof actual === 'string' && sha256(actual) === expected[hashKey],
			`${name} does not match its reviewed ${side} fingerprint`);
	}
}

function reviewedBudgetValue(value) {
	if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

export function validateReviewedModelBudgetVariables(vars, options = {}) {
	const errors = [];
	const admission = vars?.MODEL_BUDGET_ADMISSION_ENABLED;
	if (admission === undefined) return { mode: 'legacy-disabled' };
	const expectedAdmission = options.enabled === true ? 'true' : 'false';
	check(errors, admission === expectedAdmission,
		`MODEL_BUDGET_ADMISSION_ENABLED must be explicitly ${expectedAdmission}`);
	const values = Object.fromEntries(MODEL_BUDGET_VARIABLES.map((name) => [name, reviewedBudgetValue(vars?.[name])]));
	for (const name of MODEL_BUDGET_VARIABLES) {
		check(errors, values[name] !== null, `${name} must be a canonical positive safe integer`);
	}
	const item = values.MODEL_ITEM_BUDGET_MICRO_USD;
	const batch = values.MODEL_BATCH_BUDGET_MICRO_USD;
	const daily = values.MODEL_DAILY_BUDGET_MICRO_USD;
	for (const name of MODEL_BUDGET_VARIABLES.slice(0, 3)) {
		check(errors, values[name] !== null && item !== null && values[name] <= item,
			`${name} must not exceed MODEL_ITEM_BUDGET_MICRO_USD`);
		check(errors, values[name] !== null && daily !== null && values[name] <= daily,
			`${name} must not exceed MODEL_DAILY_BUDGET_MICRO_USD`);
	}
	check(errors, batch === 510000, 'MODEL_BATCH_BUDGET_MICRO_USD must equal 510000');
	check(errors, daily === 510000, 'MODEL_DAILY_BUDGET_MICRO_USD must equal 510000');
	if (errors.length) throw new ReleaseSafetyError('Reviewed model-budget configuration is not fail-closed.', errors);
	return { mode: options.enabled === true ? 'configured-enabled' : 'configured-disabled', values };
}

function explicitUtcBoundary(value) {
	return typeof value === 'string'
		&& /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
		&& Number.isFinite(Date.parse(value));
}

function automationStage(vars) {
	const values = Object.fromEntries(CAPABILITY_GATES.map((gate) => [gate, vars?.[gate] ?? 'false']));
	if (Object.values(values).some((value) => !['true', 'false'].includes(value))) return 'invalid';
	const generationEnabled = GENERATION_GATES.every((gate) => values[gate] === 'true');
	const generationDisabled = GENERATION_GATES.every((gate) => values[gate] === 'false');
	const notifications = values.EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED === 'true';
	const publication = values.EDITORIAL_AUTOMATED_PUBLICATION_ENABLED === 'true';
	const hasBoundary = Object.hasOwn(vars ?? {}, ROUTINE_GENERATION_NOT_BEFORE);
	const validBoundary = explicitUtcBoundary(vars?.[ROUTINE_GENERATION_NOT_BEFORE]);
	if (generationDisabled && !notifications && !publication && !hasBoundary) return 'disabled';
	if (generationDisabled && notifications && !publication && !hasBoundary) return 'notifications';
	if (generationEnabled && notifications && !publication && validBoundary) return 'generation-acceptance';
	if (generationDisabled && notifications && publication && !hasBoundary) return 'publication';
	if (generationEnabled && notifications && publication && validBoundary) return 'routine';
	return 'invalid';
}

function automationPolicy(vars) {
	const stage = automationStage(vars);
	return {
		stage,
		routineGenerationNotBefore: ['generation-acceptance', 'routine'].includes(stage)
			? vars?.[ROUTINE_GENERATION_NOT_BEFORE] ?? null
			: null,
	};
}

function validateAutomationConfiguration(errors, vars, policy, options = {}) {
	const expected = policy ?? { stage: 'disabled', routineGenerationNotBefore: null };
	const allowedMissingGates = new Set(options.allowedMissingGates ?? []);
	for (const gate of CAPABILITY_GATES) {
		check(errors, Object.hasOwn(vars ?? {}, gate) || allowedMissingGates.has(gate),
			`${gate} must be explicitly configured`);
	}
	check(errors, AUTOMATION_STAGES.has(expected.stage), 'automation capability policy stage is invalid');
	check(errors, automationStage(vars) === expected.stage,
		`automation capability gates do not match reviewed ${expected.stage} state`);
	if (['generation-acceptance', 'routine'].includes(expected.stage)) {
		check(errors, explicitUtcBoundary(expected.routineGenerationNotBefore),
			'automation capability policy requires an explicit UTC generation boundary');
		check(errors, vars?.[ROUTINE_GENERATION_NOT_BEFORE] === expected.routineGenerationNotBefore,
			'EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE differs from the reviewed boundary');
	} else {
		check(errors, !Object.hasOwn(vars ?? {}, ROUTINE_GENERATION_NOT_BEFORE),
			'EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE is not permitted in this automation state');
	}
}

export function validateBaselineTransition(previous, next, contract) {
	const errors = [];
	const previousIdentity = structuredClone(previous);
	const nextIdentity = structuredClone(next);
	delete previousIdentity.requiredVars;
	delete nextIdentity.requiredVars;
	delete previousIdentity.requiredSecrets;
	delete nextIdentity.requiredSecrets;
	check(errors, same(previousIdentity, nextIdentity), 'baseline fields outside requiredVars and requiredSecrets changed');
	const changes = contract?.allowedVariableChanges;
	const secretChanges = contract?.allowedSecretChanges ?? {};
	check(errors, typeof contract?.name === 'string' && contract.name.length > 0, 'transition contract name is required');
	check(errors, changes && typeof changes === 'object' && !Array.isArray(changes), 'allowedVariableChanges must be an object');
	check(errors, secretChanges && typeof secretChanges === 'object' && !Array.isArray(secretChanges),
		'allowedSecretChanges must be an object when supplied');
	const priorVars = previous.requiredVars ?? {};
	const nextVars = next.requiredVars ?? {};
	const actualChanged = [...new Set([...Object.keys(priorVars), ...Object.keys(nextVars)])]
		.filter((name) => priorVars[name] !== nextVars[name]).sort();
	const allowedChanged = changes && typeof changes === 'object' ? Object.keys(changes).sort() : [];
	check(errors, same(actualChanged, allowedChanged), 'actual variable changes differ from the reviewed transition contract');
	for (const name of allowedChanged) {
		const expected = changes[name];
		const from = Object.hasOwn(priorVars, name) ? priorVars[name] : null;
		const to = Object.hasOwn(nextVars, name) ? nextVars[name] : null;
		reviewedTransitionValue(errors, name, expected, from, 'from');
		reviewedTransitionValue(errors, name, expected, to, 'to');
	}
	const priorSecrets = new Set(previous.requiredSecrets ?? []);
	const nextSecrets = new Set(next.requiredSecrets ?? []);
	check(errors, Array.isArray(previous.requiredSecrets)
		&& priorSecrets.size === previous.requiredSecrets.length,
		'previous requiredSecrets must be a unique array');
	check(errors, Array.isArray(next.requiredSecrets)
		&& nextSecrets.size === next.requiredSecrets.length,
		'target requiredSecrets must be a unique array');
	const actualSecretChanges = [...new Set([...priorSecrets, ...nextSecrets])]
		.filter((name) => priorSecrets.has(name) !== nextSecrets.has(name)).sort();
	const allowedSecretChanges = secretChanges && typeof secretChanges === 'object'
		? Object.keys(secretChanges).sort() : [];
	check(errors, same(actualSecretChanges, allowedSecretChanges),
		'actual secret binding changes differ from the reviewed transition contract');
	for (const name of allowedSecretChanges) {
		const expected = secretChanges[name];
		const from = priorSecrets.has(name) ? 'present' : null;
		const to = nextSecrets.has(name) ? 'present' : null;
		check(errors, expected?.from === from && expected?.to === to,
			`${name} does not match its reviewed secret from/to presence`);
		check(errors, from === null && to === 'present',
			`${name} is not an additive null-to-present secret transition`);
	}
	const automationTransition = contract?.automationCapabilityTransition ?? null;
	const previousAutomation = automationPolicy(priorVars);
	const targetAutomation = automationPolicy(nextVars);
	if (automationTransition !== null) {
		check(errors, AUTOMATION_STAGES.has(automationTransition?.from)
			&& AUTOMATION_STAGES.has(automationTransition?.to),
		'automationCapabilityTransition requires reviewed from/to states');
		check(errors, AUTOMATION_TRANSITIONS.has(`${automationTransition?.from}>${automationTransition?.to}`),
			'automation capability transition is not an approved staged edge');
		check(errors, previousAutomation.stage === automationTransition?.from,
			'automation capability source state differs from the reviewed transition');
		check(errors, targetAutomation.stage === automationTransition?.to,
			'automation capability target state differs from the reviewed transition');
	} else {
		check(errors, previousAutomation.stage === 'disabled' && targetAutomation.stage === 'disabled',
			'automation capability gates must remain fully disabled without an explicit transition');
	}
	const acceptanceTransition = contract?.notificationAcceptanceTestTransition ?? null;
	if (acceptanceTransition !== null) {
		check(errors, ['enable', 'disable'].includes(acceptanceTransition),
			'notificationAcceptanceTestTransition must be enable or disable');
		check(errors, same(actualChanged, [NOTIFICATION_ACCEPTANCE_AUTHORIZATION, NOTIFICATION_ACCEPTANCE_GATE].sort()),
			'notification acceptance transition may change only its gate and authorization ID');
		check(errors, acceptanceMode(priorVars) === (acceptanceTransition === 'enable' ? 'disabled' : 'enabled'),
			'notification acceptance transition source state is invalid');
		check(errors, acceptanceMode(nextVars) === (acceptanceTransition === 'enable' ? 'enabled' : 'disabled'),
			'notification acceptance transition target state is invalid');
	} else if (Object.hasOwn(nextVars, NOTIFICATION_ACCEPTANCE_GATE)
		|| Object.hasOwn(changes ?? {}, NOTIFICATION_ACCEPTANCE_GATE)) {
		check(errors, (priorVars[NOTIFICATION_ACCEPTANCE_GATE] === undefined
			|| priorVars[NOTIFICATION_ACCEPTANCE_GATE] === 'false')
			&& nextVars[NOTIFICATION_ACCEPTANCE_GATE] === 'false',
		`${NOTIFICATION_ACCEPTANCE_GATE} must be introduced or retained as false across transition`);
		check(errors, (priorVars[NOTIFICATION_ACCEPTANCE_AUTHORIZATION] === undefined
			|| priorVars[NOTIFICATION_ACCEPTANCE_AUTHORIZATION] === '')
			&& nextVars[NOTIFICATION_ACCEPTANCE_AUTHORIZATION] === '',
		'notification acceptance-test authorization must be introduced or retained blank across transition');
	}
	check(errors, priorVars.EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY === '' && nextVars.EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY === '',
		'image smoke attempt key must remain blank across transition');
	if (Object.hasOwn(changes ?? {}, 'MODEL_BUDGET_ADMISSION_ENABLED') && automationTransition === null) {
		check(errors, priorVars.MODEL_BUDGET_ADMISSION_ENABLED === undefined,
			'previous baseline must not already contain MODEL_BUDGET_ADMISSION_ENABLED');
	}
	try {
		validateReviewedModelBudgetVariables(nextVars,
			{ enabled: ['generation-acceptance', 'routine'].includes(targetAutomation.stage) });
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	if (errors.length) throw new ReleaseSafetyError('Production baseline transition is not exact.', errors);
	const introducedDisabledGates = CAPABILITY_GATES.filter((gate) =>
		priorVars[gate] === undefined
		&& nextVars[gate] === 'false'
		&& changes[gate]?.from === null
		&& changes[gate]?.to === 'false');
	return { name: contract.name, changedVariables: actualChanged, changedSecrets: actualSecretChanges,
		introducedDisabledGates, automationCapabilities: automationTransition ? {
			transition: `${automationTransition.from}>${automationTransition.to}`,
			previous: previousAutomation,
			target: targetAutomation,
		} : null, notificationAcceptanceTest: acceptanceTransition ? {
			transition: acceptanceTransition,
			previous: { mode: acceptanceMode(priorVars), authorizationIdSha256:
				acceptanceMode(priorVars) === 'enabled' ? sha256(priorVars[NOTIFICATION_ACCEPTANCE_AUTHORIZATION]) : null },
			target: { mode: acceptanceMode(nextVars), authorizationIdSha256:
				acceptanceMode(nextVars) === 'enabled' ? sha256(nextVars[NOTIFICATION_ACCEPTANCE_AUTHORIZATION]) : null },
		} : null };
}

export function validateGeneratedConfiguration(config, baseline, options = {}) {
	const errors = [];
	const expectedCrons = options.paused ? [] : baseline.crons;
	check(errors, config.account_id === baseline.accountId, `account_id must be ${baseline.accountId}`);
	check(errors, config.name === baseline.workerName && config.topLevelName === baseline.workerName,
		`Worker identity must be ${baseline.workerName}`);
	check(errors, config.main === baseline.main, `generated entrypoint must be ${baseline.main}`);
	check(errors, config.compatibility_date === baseline.compatibilityDate, 'compatibility date differs from the reviewed baseline');
	check(errors, same(config.compatibility_flags, baseline.compatibilityFlags), 'compatibility flags differ from the reviewed baseline');
	check(errors, config.no_bundle === true, 'Astro generated configuration must keep no_bundle=true');
	check(errors, config.workers_dev === false, 'workers_dev must remain false');
	check(errors, config.preview_urls === false, 'preview_urls must remain false');
	check(errors, same(config.routes, baseline.routes), 'custom-domain routes differ from the reviewed baseline');
	const assets = config.assets ? { binding: config.assets.binding, directory: config.assets.directory } : null;
	const d1 = (config.d1_databases ?? []).map(({ binding, database_name, database_id }) => ({ binding, database_name, database_id }));
	const r2 = (config.r2_buckets ?? []).map(({ binding, bucket_name }) => ({ binding, bucket_name }));
	check(errors, same(assets, baseline.assets), 'assets binding or directory differs from the reviewed baseline');
	check(errors, same(d1, baseline.d1), 'D1 binding identity differs from the reviewed baseline');
	check(errors, same(r2, baseline.r2), 'R2 binding identity differs from the reviewed baseline');
	check(errors, same(config.triggers?.crons ?? [], expectedCrons), options.paused
		? 'paused configuration must contain no Cron schedules'
		: 'Cron schedules differ from the reviewed baseline');
	check(errors, same(config.vars ?? {}, baseline.requiredVars), 'Worker variables differ from the reviewed baseline');
	check(errors, Array.isArray(config.secrets?.required)
		&& new Set(config.secrets.required).size === config.secrets.required.length,
		'generated required secret names must be a unique array');
	check(errors, same([...(config.secrets?.required ?? [])].sort(), [...baseline.requiredSecrets].sort()),
		'generated required secret names differ from the reviewed baseline');
	validateAutomationConfiguration(errors, config.vars, options.automationCapabilities);
	if (Object.hasOwn(baseline.requiredVars ?? {}, NOTIFICATION_ACCEPTANCE_GATE)) {
		validateAcceptanceConfiguration(errors, config.vars, options.notificationAcceptanceTest);
	}
	check(errors, config.vars?.IMAGE_ATTEMPT_BUDGET_MICRO_USD === '50000', 'image attempt ceiling must equal 50000');
	check(errors, config.vars?.IMAGE_BATCH_BUDGET_MICRO_USD === '150000', 'image batch ceiling must equal 150000');
	check(errors, config.vars?.IMAGE_DAILY_BUDGET_MICRO_USD === '150000', 'image daily ceiling must equal 150000');
	check(errors, config.vars?.EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY === '', 'image smoke attempt key must be blank');
	try {
		validateReviewedModelBudgetVariables(config.vars ?? {}, { enabled:
			['generation-acceptance', 'routine'].includes(options.automationCapabilities?.stage) });
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	if (errors.length) throw new ReleaseSafetyError('Generated Wrangler configuration is not production-safe.', errors);
	return { worker: config.name, accountId: config.account_id, crons: expectedCrons.length };
}

export function validateActivationTarget(requestedVersionId, inspectedVersionId) {
	if (typeof requestedVersionId !== 'string' || !requestedVersionId
		|| requestedVersionId !== inspectedVersionId) {
		throw new ReleaseSafetyError('Inspected version does not match the requested activation version.');
	}
	return true;
}

export function createCronConfiguration(config, baseline, paused, options = {}) {
	validateGeneratedConfiguration(config, baseline, options);
	const result = structuredClone(config);
	result.triggers = { ...(result.triggers ?? {}), crons: paused ? [] : [...baseline.crons] };
	validateGeneratedConfiguration(result, baseline, { ...options, paused });
	assertOnlyCronDifference(config, result);
	return result;
}

export function assertOnlyCronDifference(original, candidate) {
	const left = structuredClone(original);
	const right = structuredClone(candidate);
	if (left.triggers) left.triggers.crons = [];
	if (right.triggers) right.triggers.crons = [];
	if (!same(left, right)) {
		throw new ReleaseSafetyError('Cron configuration changed fields outside triggers.crons.');
	}
}

async function filesUnder(root) {
	const found = [];
	async function walk(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) found.push(path);
		}
	}
	await walk(root);
	return found;
}

async function moduleSpecifiers(source) {
	await init;
	const [imports] = parse(source);
	return [...new Set(imports.map((item) => item.n).filter((specifier) => typeof specifier === 'string'))];
}

async function existingModule(base, specifier) {
	const direct = resolve(dirname(base), specifier);
	const candidates = extname(direct) ? [direct] : [direct, `${direct}.mjs`, `${direct}.js`, join(direct, 'index.mjs'), join(direct, 'index.js')];
	for (const candidate of candidates) {
		try {
			if ((await stat(candidate)).isFile()) return candidate;
		} catch {}
	}
	return null;
}

export async function validateModuleGraph(serverDirectory, main = 'entry.mjs') {
	const root = resolve(serverDirectory);
	const entry = resolve(root, main);
	try {
		if (!(await stat(entry)).isFile()) throw new Error();
	} catch {
		throw new ReleaseSafetyError(`Worker entrypoint is missing: ${main}`);
	}
	const pending = [entry];
	const visited = new Set();
	const missing = [];
	while (pending.length) {
		const current = pending.pop();
		if (!current || visited.has(current)) continue;
		visited.add(current);
		const source = await readFile(current, 'utf8');
		for (const specifier of await moduleSpecifiers(source)) {
			if (!specifier.startsWith('.')) continue;
			const resolved = await existingModule(current, specifier);
			if (!resolved) missing.push(`${relative(root, current)} -> ${specifier}`);
			else if (resolved.startsWith(`${root}${sep}`) || resolved === root) pending.push(resolved);
			else missing.push(`${relative(root, current)} escapes generated server directory: ${specifier}`);
		}
	}
	if (missing.length) throw new ReleaseSafetyError('Generated Worker module graph is incomplete.', missing);
	return [...visited].map((path) => relative(root, path).replaceAll('\\', '/')).sort();
}

function javascriptFiles(paths, root) {
	return paths.filter((path) => ['.js', '.mjs'].includes(extname(path)))
		.map((path) => relative(root, path).replaceAll('\\', '/')).sort();
}

export async function validateDryRunPackage(serverDirectory, packageDirectory, config) {
	const sourceRoot = resolve(serverDirectory);
	const packageRoot = resolve(packageDirectory);
	const graph = await validateModuleGraph(sourceRoot, config.main);
	const [sourcePaths, packagePaths] = await Promise.all([filesUnder(sourceRoot), filesUnder(packageRoot)]);
	const generated = javascriptFiles(sourcePaths, sourceRoot);
	const packaged = new Set(javascriptFiles(packagePaths, packageRoot));
	const missing = generated.filter((path) => !packaged.has(path));
	const graphMissing = graph.filter((path) => !packaged.has(path));
	const rules = config.rules ?? [];
	const coversJavaScript = rules.some((rule) => rule.type === 'ESModule'
		&& rule.globs?.includes('**/*.js') && rule.globs?.includes('**/*.mjs'));
	if (!coversJavaScript) missing.push('Wrangler ESModule rules do not cover both **/*.js and **/*.mjs');
	if (missing.length || graphMissing.length) {
		throw new ReleaseSafetyError('Wrangler dry-run package omitted generated Worker modules.',
			[...new Set([...missing, ...graphMissing])]);
	}
	return { generatedModules: generated.length, reachableModules: graph.length, packagedModules: packaged.size };
}

export function validateLiveSnapshot(snapshot, baseline, options = {}) {
	const errors = [];
	const expectedCrons = options.paused ? [] : baseline.crons;
	const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
	const capturedAtFormat = typeof snapshot.capturedAt === 'string'
		&& /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(snapshot.capturedAt);
	const capturedAt = capturedAtFormat ? new Date(snapshot.capturedAt) : null;
	const ageMs = capturedAt && Number.isFinite(capturedAt.getTime()) ? now.getTime() - capturedAt.getTime() : null;
	check(errors, ageMs !== null, 'live snapshot capturedAt must be a valid timestamp');
	check(errors, ageMs !== null && ageMs >= 0 && ageMs <= LIVE_SNAPSHOT_MAX_AGE_MS,
		'live snapshot is stale or dated in the future');
	check(errors, snapshot.accountId === baseline.accountId, 'authenticated Cloudflare account does not match production');
	check(errors, snapshot.workerName === baseline.workerName, 'live Worker identity does not match production');
	check(errors, same(snapshot.d1, baseline.d1), 'live D1 bindings do not match production');
	check(errors, same(snapshot.r2, baseline.r2), 'live R2 bindings do not match production');
	check(errors, same(snapshot.assets, baseline.assets), 'live assets binding does not match production');
	check(errors, snapshot.workersDev === false, 'live workers.dev exposure is enabled');
	check(errors, snapshot.previewUrls === false, 'live preview URL exposure is enabled');
	check(errors, same(snapshot.routes, baseline.routes), 'live custom-domain routes differ from baseline');
	check(errors, same(snapshot.crons, expectedCrons), options.paused
		? 'live Cron schedules are not fully paused'
		: 'live Cron schedules differ from baseline');
	check(errors, same(snapshot.vars ?? {}, baseline.requiredVars), 'live Worker variables differ from baseline');
	const allowedMissingGates = options.liveState === 'previous'
		? options.transition?.introducedDisabledGates ?? []
		: [];
	validateAutomationConfiguration(errors, snapshot.vars, options.automationCapabilities,
		{ allowedMissingGates });
	check(errors, snapshot.vars?.EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY === '', 'live image smoke attempt key must be blank');
	if (Object.hasOwn(baseline.requiredVars ?? {}, NOTIFICATION_ACCEPTANCE_GATE)) {
		validateAcceptanceConfiguration(errors, snapshot.vars, options.notificationAcceptanceTest);
	}
	try {
		validateReviewedModelBudgetVariables(snapshot.vars ?? {}, { enabled:
			['generation-acceptance', 'routine'].includes(options.automationCapabilities?.stage) });
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	check(errors, same([...(snapshot.secretNames ?? [])].sort(), [...baseline.requiredSecrets].sort()),
		'live secret binding names differ from baseline');
	if (errors.length) throw new ReleaseSafetyError('Live production identity or configuration is not safe.', errors);
	return true;
}

export function validateDisabledVersionSnapshot(snapshot, baseline) {
	const version = normalizeVersionSnapshot(snapshot);
	const errors = [];
	if (snapshot.workerName !== undefined) check(errors, snapshot.workerName === baseline.workerName, 'version belongs to a different Worker');
	if (snapshot.accountId !== undefined) check(errors, snapshot.accountId === baseline.accountId, 'version belongs to a different account');
	for (const gate of DISABLED_GATES) {
		check(errors, version.vars[gate] === 'false', `rollback version has ${gate} enabled`);
	}
	if (Object.hasOwn(baseline.requiredVars ?? {}, 'MODEL_BUDGET_ADMISSION_ENABLED')) {
		check(errors, version.vars.MODEL_BUDGET_ADMISSION_ENABLED === 'false',
			'rollback version has MODEL_BUDGET_ADMISSION_ENABLED enabled');
	}
	check(errors, version.vars.EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY === '', 'rollback version has a nonblank image attempt key');
	if (Object.hasOwn(baseline.requiredVars ?? {}, 'EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED')) {
		check(errors, version.vars.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED === 'false',
			'rollback version has notification acceptance testing enabled');
		check(errors, version.vars.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID === '',
			'rollback version has a nonblank notification acceptance-test authorization');
	}
	if (errors.length) throw new ReleaseSafetyError('Rollback target is not a verified all-generation-disabled version.', errors);
	return true;
}

function normalizeVersionSnapshot(snapshot) {
	const bindings = snapshot.resources?.bindings ?? [];
	const vars = Object.fromEntries(bindings.filter((binding) => binding.type === 'plain_text')
		.map((binding) => [binding.name, binding.text]));
	return {
		vars,
		secrets: bindings.filter((binding) => binding.type === 'secret_text').map((binding) => binding.name),
		d1: bindings.filter((binding) => binding.type === 'd1'),
		r2: bindings.filter((binding) => binding.type === 'r2_bucket'),
		assets: bindings.filter((binding) => binding.type === 'assets'),
		handlers: snapshot.resources?.script?.handlers ?? [],
		compatibilityDate: snapshot.resources?.script_runtime?.compatibility_date,
		compatibilityFlags: snapshot.resources?.script_runtime?.compatibility_flags ?? [],
	};
}

export function validateUploadedVersion(snapshot, baseline, options = {}) {
	const version = normalizeVersionSnapshot(snapshot);
	const errors = [];
	check(errors, version.handlers.includes('fetch') && version.handlers.includes('scheduled'), 'uploaded version must contain fetch and scheduled handlers');
	check(errors, version.compatibilityDate === baseline.compatibilityDate, 'uploaded version compatibility date differs');
	check(errors, same(version.compatibilityFlags, baseline.compatibilityFlags), 'uploaded version compatibility flags differ');
	check(errors, same(version.vars, baseline.requiredVars), 'uploaded version variables differ from baseline');
	validateAutomationConfiguration(errors, version.vars, options.automationCapabilities);
	if (Object.hasOwn(baseline.requiredVars ?? {}, NOTIFICATION_ACCEPTANCE_GATE)) {
		validateAcceptanceConfiguration(errors, version.vars, options.notificationAcceptanceTest);
	}
	check(errors, same([...version.secrets].sort(), [...baseline.requiredSecrets].sort()),
		'uploaded version secret binding names differ from baseline');
	const d1 = version.d1.map(({ name, database_id }) => ({ binding: name, database_id }));
	const r2 = version.r2.map(({ name, bucket_name }) => ({ binding: name, bucket_name }));
	const expectedD1 = baseline.d1.map(({ binding, database_id }) => ({ binding, database_id }));
	check(errors, same(d1, expectedD1), 'uploaded version D1 bindings differ from baseline');
	check(errors, same(r2, baseline.r2), 'uploaded version R2 bindings differ from baseline');
	check(errors, same(version.assets.map(({ name }) => name), [baseline.assets.binding]),
		'uploaded version assets bindings differ from baseline');
	if (errors.length) throw new ReleaseSafetyError('Uploaded Worker version differs from the reviewed release configuration.', errors);
	return { versionId: snapshot.id, bindings: snapshot.resources?.bindings?.length ?? 0 };
}

export async function validateDeployedModuleInventory(serverDirectory, inventory) {
	const root = resolve(serverDirectory);
	const generated = javascriptFiles(await filesUnder(root), root);
	const deployed = new Set(inventory.modules ?? []);
	const missing = generated.filter((module) => !deployed.has(module));
	if (missing.length) throw new ReleaseSafetyError('Deployed Worker module inventory is incomplete.', missing);
	return { generatedModules: generated.length, deployedModules: deployed.size };
}
