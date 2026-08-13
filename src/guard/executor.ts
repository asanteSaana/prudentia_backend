import {Constants} from '../_services/_constants';
import {ReadOnlyDatabase} from '../_services/databaseService';
import {ErrorCode} from '../_services/errorService';

/**
 * Stage 5: execute a statement the gate has PROVEN safe (FR-14, NFR-11, ADR-03).
 *
 * This is the only place in the codebase that executes generated SQL, and the
 * `no-generated-sql-outside-guard` lint rule enforces that mechanically.
 *
 * Two independent guards on the row ceiling, by design (CLAUDE.md §4 rule 3):
 *   1. the gate WRAPS the statement in `SELECT * FROM (...) LIMIT n` before it gets here
 *   2. this executor slices the returned array to the same ceiling
 *
 * The second exists because the first is applied by a module that could, in principle,
 * be changed. Two guards fail independently; one guard is a single point of failure
 * wearing a belt.
 */

export interface ResultColumn {
	name: string;
	type: string;
}

export interface ExecutionResult {
	columns: ResultColumn[];
	rows: unknown[][];
	rowCount: number;
	durationMs: number;
	/** True when the ceiling actually bit — the interface tells the user so. */
	truncated: boolean;
}

export class ExecutionError extends Error {
	readonly timedOut: boolean;

	constructor(message: string, timedOut: boolean) {
		super(message);
		this.name = 'ExecutionError';
		this.timedOut = timedOut;
	}
}

/** Postgres reports numeric OIDs; the interface only needs a coarse family. */
const TYPE_FAMILIES: Record<number, string> = {
	20: 'numeric', // int8
	21: 'numeric', // int2
	23: 'numeric', // int4
	700: 'numeric', // float4
	701: 'numeric', // float8
	1700: 'numeric', // numeric
	16: 'boolean',
	1082: 'date',
	1114: 'timestamp',
	1184: 'timestamp'
};

export async function executeValidatedSql(sql: string): Promise<ExecutionResult> {
	const started = Date.now();

	try {
		/**
		 * The statement text arrived from the gate and is executed as-is, with NO
		 * parameter interpolation of any kind — there is no user input left to bind. The
		 * `statement_timeout` and `default_transaction_read_only` that bound this call are
		 * set on the ROLE in a migration and again on the pool connection, so they hold
		 * even if this function is called from somewhere unexpected.
		 */
		const result = await ReadOnlyDatabase.getInstance().raw(sql);

		const fields: Array<{name: string; dataTypeID: number}> = result.fields ?? [];
		const allRows: Record<string, unknown>[] = result.rows ?? [];

		const columns: ResultColumn[] = fields.map(field => ({
			name: field.name,
			type: TYPE_FAMILIES[field.dataTypeID] ?? 'text'
		}));

		// GUARD 2. Independent of the gate's wrap.
		const truncated = allRows.length > Constants.MAX_RESULT_ROWS;
		const limited = truncated ? allRows.slice(0, Constants.MAX_RESULT_ROWS) : allRows;

		const rows = limited.map(row => columns.map(column => normalise(row[column.name])));

		return {
			columns,
			rows,
			rowCount: rows.length,
			durationMs: Date.now() - started,
			truncated
		};
	} catch (error: unknown) {
		const code = (error as {code?: string})?.code;
		const timedOut = code === ErrorCode.QueryCanceled;

		/**
		 * The driver's message names columns, constraints and sometimes row values. It is
		 * carried on the ExecutionError for the AUDIT LOG and never reaches the client —
		 * the orchestrator translates every one of these into a fixed sentence (FR-16,
		 * NFR-08, TH-10). Test D-11 asserts a bad-column error does not leak the column
		 * name.
		 */
		throw new ExecutionError((error as Error)?.message ?? 'Execution failed', timedOut);
	}
}

/**
 * `pg` returns `numeric` as a string to preserve precision, which is correct for money
 * and wrong for a chart. Converted here, at the boundary, so the frontend never has to
 * guess whether a value is a number.
 */
function normalise(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (typeof value === 'string') {
		// Only convert what is unambiguously numeric — a policy number must stay a string.
		if (/^-?\d+(\.\d+)?$/.test(value)) {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : value;
		}
	}
	return value;
}
