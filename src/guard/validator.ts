import {parseSync} from 'libpg-query';
import {Constants} from '../_services/_constants';
import {ALLOWED_COLUMNS, ALLOWED_TABLES} from './catalogue';

/**
 * THE VALIDATION GATE — the security boundary of the entire system.
 *
 * Everything upstream is untrusted; everything downstream assumes the statement has
 * been PROVEN safe. A defect here is a total compromise, which is why this module
 * carries a 90% statement-coverage floor (NFR-17) and a 36-case adversarial corpus that
 * must stay at 100% rejection.
 *
 * FR-11 to FR-14, NFR-01, NFR-03. Specification: docs/02 §6.2.
 *
 * ── The two rules that shape everything below ────────────────────────────────
 *
 * **Whitelist of one statement type.** A statement is permitted only if it parses to
 * exactly one `SelectStmt`. Forbidden kinds are never enumerated. A blacklist fails
 * open — anything PostgreSQL adds in a future major version would be permitted by an
 * enumeration written today. A whitelist of one fails closed by construction.
 *
 * **Comments are rejected on the RAW STRING, before parsing.** This ordering is not a
 * preference and cannot be moved. The parser strips comments, so
 * `SELECT id FROM claims -- ; DROP TABLE claims` parses to one clean `SelectStmt` and
 * would sail through every later check.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────
 *
 * No regular expression is applied to SQL for any validation purpose. The AST check is
 * the check; a regex alongside it would invite trusting the regex. The only string
 * inspection here is the comment scan, which runs BEFORE the string is SQL to us at all.
 */

export const MAX_ROWS = Constants.MAX_RESULT_ROWS;

/** FR-08 caps the QUESTION at 500 chars; generated SQL is bounded separately. */
const MAX_SQL_LENGTH = 8000;

export interface ValidationResult {
	permitted: boolean;
	/** The wrapped, executable statement. NULL whenever `permitted` is false. */
	normalisedSql: string | null;
	/** AUDIT LOG ONLY. Never sent to a client — a specific reason is a probing oracle. */
	reason: string | null;
	/** AUDIT LOG ONLY. The triage taxonomy (docs/04 §3.1). */
	failedCheck: string | null;
}

const CHECKS = {
	malformed: 'malformed',
	comment: 'comment',
	parse: 'parse',
	singleStatement: 'single_statement',
	rootNotSelect: 'root_not_select',
	tableNotWhitelisted: 'table_not_whitelisted',
	unknownColumn: 'unknown_column',
	forbiddenFunction: 'forbidden_function',
	schemaQualified: 'schema_qualified',
	wrapFailed: 'wrap_failed'
} as const;

/**
 * Functions denied outright.
 *
 * The specification lists a handful by name. Enumerating is the wrong shape for the
 * same reason a statement blacklist is: it can only ever cover what was thought of.
 * The rule below is therefore structural — **the entire `pg_` namespace is denied** —
 * with a short list for the dangerous functions that do not carry that prefix.
 *
 * No legitimate analytical query calls a `pg_*` function. Aggregates, window functions
 * and date arithmetic are all unprefixed, so this costs the benign corpus nothing.
 */
const FORBIDDEN_FUNCTION_PREFIXES = ['pg_', 'dblink', 'lo_'];
const FORBIDDEN_FUNCTIONS = new Set([
	'set_config',
	'current_setting',
	'query_to_xml',
	'query_to_xmlschema',
	'xmlelement',
	'system',
	'copy',
	'to_regclass',
	'to_regproc',
	'has_table_privilege',
	'has_column_privilege',
	'current_user',
	'session_user',
	'inet_server_addr',
	'inet_client_addr',
	'version'
]);

/** Only `public` may be named explicitly. This is what blocks pg_catalog and information_schema. */
const ALLOWED_SCHEMA = 'public';

function reject(failedCheck: string, reason: string): ValidationResult {
	return {permitted: false, normalisedSql: null, reason, failedCheck};
}

/**
 * Walk the whole parse tree, collecting every value stored under `key`.
 *
 * Deliberately structural rather than targeted: it descends into every object and array
 * without knowing anything about statement shape. A targeted walker would need to know
 * where subqueries, CTEs, set operations, lateral joins and window frames can each hide
 * a table reference — and would miss whichever one it had not been taught about. This
 * cannot miss one, because it does not know what it is looking at.
 */
function collect(node: unknown, key: string, out: any[] = []): any[] {
	if (!node || typeof node !== 'object') return out;

	if (Array.isArray(node)) {
		for (const item of node) collect(item, key, out);
		return out;
	}

	for (const [property, value] of Object.entries(node as Record<string, unknown>)) {
		if (property === key) out.push(value);
		collect(value, key, out);
	}
	return out;
}

/** libpg-query stores identifier text as `{String: {sval}}`. */
function stringValue(field: unknown): string | null {
	const node = field as {String?: {sval?: string}} | null;
	return node?.String?.sval ?? null;
}

export async function validateSql(sql: string): Promise<ValidationResult> {
	// ── 1. Non-empty, within length bound ────────────────────────────────────
	if (typeof sql !== 'string' || sql.trim().length === 0) {
		return reject(CHECKS.malformed, 'Statement was empty or not a string.');
	}
	if (sql.length > MAX_SQL_LENGTH) {
		return reject(CHECKS.malformed, `Statement exceeded ${MAX_SQL_LENGTH} characters.`);
	}

	// ── 2. Comment tokens, on the RAW STRING, BEFORE parsing ─────────────────
	// NON-NEGOTIABLE ORDERING. The parser discards comments, so moving this check
	// after the parse makes `SELECT id FROM claims -- ; DROP TABLE claims` look like a
	// clean single SelectStmt. Cases S-12, S-13 and S-14 exist to hold this in place.
	if (sql.includes('--') || sql.includes('/*') || sql.includes('*/')) {
		return reject(CHECKS.comment, 'Statement contained a SQL comment token.');
	}

	// ── 3. Parses without throwing ───────────────────────────────────────────
	let parsed: {stmts: Array<{stmt: Record<string, unknown>}>};
	try {
		parsed = parseSync(sql) as typeof parsed;
	} catch (error: any) {
		// The parser's message names schema objects and syntax positions. It goes to the
		// audit log and NEVER to the client (TH-10, FR-16).
		return reject(CHECKS.parse, `Statement did not parse: ${error?.message ?? 'unknown parse error'}`);
	}

	// ── 4. Exactly one statement ─────────────────────────────────────────────
	if (!parsed?.stmts || parsed.stmts.length !== 1) {
		return reject(
			CHECKS.singleStatement,
			`Expected exactly one statement, found ${parsed?.stmts?.length ?? 0}.`
		);
	}

	// ── 5. That statement is a SELECT — whitelist of one ─────────────────────
	const statementKind = Object.keys(parsed.stmts[0].stmt ?? {})[0];
	if (statementKind !== 'SelectStmt') {
		return reject(CHECKS.rootNotSelect, `Statement kind was ${statementKind ?? 'unknown'}, not SelectStmt.`);
	}

	const tree = parsed.stmts;

	/**
	 * ── 5b. A SelectStmt that is not actually a pure read ────────────────────
	 *
	 * This check is NOT in the specification's list, and it is the most important thing
	 * the port added. The whitelist-of-one is necessary but not sufficient, because two
	 * PostgreSQL constructs are `SelectStmt` in the grammar yet are not reads:
	 *
	 *   SELECT * INTO evil FROM claims     -- CREATE TABLE AS in disguise. It WRITES.
	 *   SELECT id FROM claims FOR UPDATE   -- takes row locks; write intent, and a
	 *                                      -- lock-contention denial-of-service vector.
	 *
	 * `SELECT INTO` was PERMITTED by this gate until it was probed for directly. The
	 * statement kind check cannot catch it — the kind really is SelectStmt — so the
	 * distinction has to be drawn on the clause. The Python/sqlglot implementation did
	 * not need this check because sqlglot models `SELECT INTO` as a separate node type;
	 * PostgreSQL's own parser does not, and using the real parser means inheriting the
	 * real grammar's shape, warts included.
	 *
	 * This is the counter-example to "the AST kind is the whole check". Recorded as
	 * defect R-02 and covered in `__tests__/regression.test.ts`.
	 */
	if (collect(tree, 'intoClause').some(clause => clause !== null && clause !== undefined)) {
		return reject(CHECKS.rootNotSelect, 'SELECT ... INTO creates a table; it is not a read.');
	}
	if (collect(tree, 'lockingClause').some(clause => clause !== null && clause !== undefined)) {
		return reject(CHECKS.rootNotSelect, 'SELECT ... FOR UPDATE/SHARE takes row locks; it is not a pure read.');
	}

	/**
	 * Identifiers the query INTRODUCES ITSELF, in TWO separate sets.
	 *
	 * The separation is a security boundary, not tidiness. An earlier version pooled
	 * them into one set and was BYPASSABLE:
	 *
	 *     SELECT 1 AS users, * FROM users        -- was PERMITTED
	 *
	 * The `AS users` output alias landed in the shared set, and the table check then
	 * excused the `users` RangeVar as "an identifier the query introduced". A single
	 * output alias was enough to unlock any table in the database.
	 *
	 *   • `cteNames`  — may appear in TABLE position. Only a CTE can; a CTE really is a
	 *                   relation the statement defines.
	 *   • `columnNames` — may appear in COLUMN position: output aliases, table aliases,
	 *                   subquery aliases, CTE column lists. None of these is a relation.
	 *
	 * Collected BEFORE any name check, because checking against the catalogue alone
	 * refuses legitimate work — `SELECT COUNT(*) AS n FROM claims ORDER BY n` is the
	 * canonical case (reference defect D-03, benign case B-06).
	 */
	const cteNames = new Set<string>();
	const columnNames = new Set<string>();

	for (const cte of collect(tree, 'CommonTableExpr')) {
		if (cte?.ctename) {
			cteNames.add(cte.ctename);
			columnNames.add(cte.ctename);
		}
		for (const column of cte?.aliascolnames ?? []) {
			const name = stringValue(column);
			if (name) columnNames.add(name);
		}
	}
	for (const target of collect(tree, 'ResTarget')) {
		if (target?.name) columnNames.add(target.name);
	}
	for (const alias of collect(tree, 'alias')) {
		if (alias?.aliasname) columnNames.add(alias.aliasname);
		for (const column of alias?.colnames ?? []) {
			const name = stringValue(column);
			if (name) columnNames.add(name);
		}
	}

	// ── 6. Every referenced table is whitelisted ─────────────────────────────
	const rangeVars = collect(tree, 'RangeVar');
	for (const rangeVar of rangeVars) {
		const relation: string | undefined = rangeVar?.relname;
		if (!relation) continue;

		// A CTE is referenced exactly like a table, so its NAME is excused here — and
		// ONLY a CTE name is. Its body is walked too, so
		// `WITH u AS (SELECT * FROM users) SELECT * FROM u` is still caught on `users`
		// (case S-25): accepting the CTE name does not accept its contents.
		if (cteNames.has(relation)) continue;

		if (!ALLOWED_TABLES.has(relation)) {
			return reject(CHECKS.tableNotWhitelisted, `Table "${relation}" is not in the schema catalogue.`);
		}
	}

	// ── 7. Every referenced column exists, or the query introduced it ────────
	for (const columnRef of collect(tree, 'ColumnRef')) {
		const fields: unknown[] = columnRef?.fields ?? [];
		if (fields.length === 0) continue;

		const last = fields[fields.length - 1];
		// `SELECT *` and `t.*` parse as A_Star, not a name. Safe by this point: every
		// table in the statement has already been proven to be in the catalogue.
		if (last && typeof last === 'object' && 'A_Star' in (last as object)) continue;

		const name = stringValue(last);
		if (!name) continue;

		if (!ALLOWED_COLUMNS.has(name) && !columnNames.has(name)) {
			return reject(CHECKS.unknownColumn, `Column "${name}" is not in the schema catalogue.`);
		}
	}

	// ── 8. No forbidden function ─────────────────────────────────────────────
	for (const call of collect(tree, 'FuncCall')) {
		const parts: string[] = (call?.funcname ?? []).map(stringValue).filter(Boolean) as string[];
		if (parts.length === 0) continue;

		const bare = parts[parts.length - 1].toLowerCase();
		const qualifier = parts.length > 1 ? parts[0].toLowerCase() : null;

		if (qualifier && qualifier !== ALLOWED_SCHEMA) {
			return reject(CHECKS.forbiddenFunction, `Function "${parts.join('.')}" is schema-qualified outside public.`);
		}
		if (FORBIDDEN_FUNCTIONS.has(bare) || FORBIDDEN_FUNCTION_PREFIXES.some(prefix => bare.startsWith(prefix))) {
			return reject(CHECKS.forbiddenFunction, `Function "${bare}" is forbidden.`);
		}
	}

	// ── 9. No schema qualifier other than public ─────────────────────────────
	// Belt and braces with check 6: `pg_catalog.pg_tables` is already refused there
	// because `pg_tables` is not in the catalogue. This holds the boundary explicitly
	// so that adding a table named like a catalogue relation could never open it.
	for (const rangeVar of rangeVars) {
		const schema: string | undefined = rangeVar?.schemaname;
		if (schema && schema !== ALLOWED_SCHEMA) {
			return reject(CHECKS.schemaQualified, `Schema "${schema}" is not permitted; only ${ALLOWED_SCHEMA} is.`);
		}
	}

	// ── 10. Row ceiling by WRAPPING, never by string rewriting ───────────────
	// libpg-query has no deparser, so mutating the AST and re-emitting is unavailable —
	// and that constraint is a feature. The proven text is never altered; an outer bound
	// is placed around it. A smaller inner LIMIT still wins naturally, so injection,
	// capping and preservation are one path with no conditionals.
	const inner = sql.trim().replace(/;\s*$/, '');
	const wrapped = `SELECT * FROM (${inner}) AS _guarded LIMIT ${MAX_ROWS}`;

	// Re-parse and re-assert. The wrap must not be able to change what the statement IS.
	try {
		const rewrapped = parseSync(wrapped) as typeof parsed;
		if (rewrapped.stmts.length !== 1 || Object.keys(rewrapped.stmts[0].stmt ?? {})[0] !== 'SelectStmt') {
			return reject(CHECKS.wrapFailed, 'Wrapped statement was no longer a single SelectStmt.');
		}
	} catch (error: any) {
		return reject(CHECKS.wrapFailed, `Wrapped statement did not parse: ${error?.message ?? 'unknown'}`);
	}

	return {permitted: true, normalisedSql: wrapped, reason: null, failedCheck: null};
}
