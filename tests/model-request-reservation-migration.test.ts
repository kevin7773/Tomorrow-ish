import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(process.cwd(),
	'migrations/0017_reclassify_definitive_provider_rejections.sql'), 'utf8');

const incident = {
	key: 'generate:5ddcc5c9-3fe1-4f1c-bc57-6e749e9d5d4d:f4b7b8c7-342f-4ac7-b1fb-9a704381875e',
	runId: '93162d5c-8274-447e-91fe-3698bf62fd6c',
	requestId: 'req_cf418a81079944ca98b9683350cfa5fd',
};

function database(): DatabaseSync {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(`
		CREATE TABLE model_runs (
			id TEXT PRIMARY KEY,
			idempotency_key TEXT NOT NULL,
			operation TEXT NOT NULL,
			source_intake_id TEXT NOT NULL,
			normalized_event_version_id TEXT,
			status TEXT NOT NULL,
			failure_classification TEXT,
			provider_http_status INTEGER,
			provider_error_type TEXT,
			provider_error_code TEXT,
			provider_request_id TEXT,
			retry_count INTEGER NOT NULL
		);
		CREATE TABLE model_request_reservations (
			idempotency_key TEXT PRIMARY KEY,
			operation TEXT NOT NULL,
			source_intake_id TEXT NOT NULL,
			normalized_event_version_id TEXT,
			status TEXT NOT NULL,
			failure_reason TEXT
		);
		CREATE TRIGGER model_request_reservations_terminal_immutable
		BEFORE UPDATE ON model_request_reservations
		WHEN OLD.status <> 'PENDING'
		BEGIN
			SELECT RAISE(ABORT, 'terminal model request reservations are immutable');
		END;
	`);
	return sqlite;
}

function insertOutcome(sqlite: DatabaseSync, input: {
	key: string; httpStatus: number | null; errorCode: string | null; requestId: string | null;
	runId?: string; intakeId?: string; versionId?: string;
}): void {
	sqlite.prepare(`INSERT INTO model_request_reservations
		(idempotency_key,operation,source_intake_id,normalized_event_version_id,status,failure_reason)
		VALUES (?,'GENERATE_CANDIDATES',?,?,'AMBIGUOUS','PROVIDER_REQUEST')`)
		.run(input.key, input.intakeId ?? '2c7f63bc-a733-4952-84f3-3bc6048290cb',
			input.versionId ?? '5ddcc5c9-3fe1-4f1c-bc57-6e749e9d5d4d');
	sqlite.prepare(`INSERT INTO model_runs
		(id,idempotency_key,operation,source_intake_id,normalized_event_version_id,status,
		failure_classification,provider_http_status,provider_error_type,provider_error_code,provider_request_id,retry_count)
		VALUES (?,?,'GENERATE_CANDIDATES',?,?,'FAILED','PROVIDER_REQUEST',?,'invalid_request_error',?,?,0)`)
		.run(input.runId ?? `run:${input.key}`, input.key,
			input.intakeId ?? '2c7f63bc-a733-4952-84f3-3bc6048290cb',
			input.versionId ?? '5ddcc5c9-3fe1-4f1c-bc57-6e749e9d5d4d',
			input.httpStatus, input.errorCode, input.requestId);
}

describe('definitive provider rejection reservation migration', () => {
	it('reclassifies only persisted HTTP 400 invalid-schema evidence and restores terminal immutability', () => {
		const sqlite = database();
		insertOutcome(sqlite, { key: incident.key, runId: incident.runId, httpStatus: 400,
			errorCode: 'invalid_json_schema', requestId: incident.requestId });
		insertOutcome(sqlite, { key: 'lost-response', httpStatus: null,
			errorCode: null, requestId: null });
		insertOutcome(sqlite, { key: 'server-failure', httpStatus: 500,
			errorCode: 'server_error', requestId: 'req_server' });

		sqlite.exec(migration);

		expect(sqlite.prepare(`SELECT status FROM model_request_reservations
			WHERE idempotency_key=?`).get(incident.key)).toEqual({ status: 'FAILED' });
		expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM model_request_reservations
			WHERE idempotency_key<>? AND status='AMBIGUOUS'`).get(incident.key)).toEqual({ count: 2 });
		expect(() => sqlite.prepare(`UPDATE model_request_reservations SET status='FAILED'
			WHERE idempotency_key='lost-response'`).run()).toThrow(/terminal model request reservations are immutable/i);
		sqlite.close();
	});

	it('does not reclassify a near-match with different persisted provider evidence', () => {
		const sqlite = database();
		insertOutcome(sqlite, { key: incident.key, runId: incident.runId, httpStatus: 400,
			errorCode: 'invalid_json_schema', requestId: 'req_different' });

		sqlite.exec(migration);
		expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM model_request_reservations
			WHERE status='FAILED'`).get()).toEqual({ count: 0 });
		sqlite.close();
	});
});
