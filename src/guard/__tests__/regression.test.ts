import {loadModule} from 'libpg-query';
import {validateSql} from '../validator';

/**
 * Bypasses found during construction, by attacking the gate rather than by running the
 * corpus. Each was PERMITTED at the moment it was found.
 *
 * These are kept separate from the 36-case specification corpus so that corpus stays a
 * faithful port of docs/03 §5.1 and its count assertion keeps meaning what it says.
 * The corpus is the specification's idea of an attacker; this file is the build's own.
 *
 * The lesson worth carrying into Phase 7: the 36 cases all passed on the first run of
 * the finished gate. A corpus you wrote to a specification tells you the specification
 * is satisfied — it does not tell you the boundary holds.
 */

beforeAll(async () => {
	await loadModule();
});

describe('regression — alias shadowing must not excuse a table reference (R-01)', () => {
	/**
	 * Root cause: output aliases, table aliases, subquery aliases and CTE names were
	 * pooled into ONE set of "identifiers the query introduced", and the table check
	 * consulted it. A single `AS <tablename>` was therefore enough to excuse any
	 * relation in the database from the whitelist.
	 *
	 * Only a CTE name may appear in table position. Everything else is column-position
	 * only.
	 */
	const BYPASSES: Array<[string, string]> = [
		['output alias shadows users, with star', 'SELECT 1 AS users, * FROM users'],
		['output alias shadows users, catalogue column', 'SELECT 1 AS users, id FROM users'],
		['output alias shadows query_log', 'SELECT 1 AS query_log, * FROM query_log'],
		['subquery alias shadows a table', 'SELECT * FROM (SELECT 1) AS users, users'],
		['output alias shadows pg_shadow', 'SELECT 1 AS pg_shadow, * FROM pg_shadow'],
		['alias shadow reaching password_hash', 'SELECT 1 AS users, id, password_hash FROM users']
	];

	test.each(BYPASSES)('%s', async (_name, sql) => {
		const result = await validateSql(sql);
		expect(result.permitted).toBe(false);
		expect(result.normalisedSql).toBeNull();
	});
});

describe('regression — a CTE name IS legitimate in table position', () => {
	// The fix must not over-correct. This is the boundary on the other side.
	it('permits a CTE referenced by name', async () => {
		const result = await validateSql(
			`WITH monthly AS (SELECT DATE_TRUNC('month', incident_date) AS m, COUNT(*) AS n FROM claims GROUP BY 1)
			 SELECT m, n FROM monthly ORDER BY m`
		);
		expect(result.permitted).toBe(true);
	});

	it('still rejects a CTE whose BODY reaches outside the catalogue', async () => {
		const result = await validateSql('WITH u AS (SELECT id FROM users) SELECT id FROM u');
		expect(result.permitted).toBe(false);
		expect(result.failedCheck).toBe('table_not_whitelisted');
	});

	it('rejects a CTE named after a real table whose body reaches elsewhere', async () => {
		// Shadowing a whitelisted name must not launder the body.
		const result = await validateSql('WITH claims AS (SELECT id FROM query_log) SELECT id FROM claims');
		expect(result.permitted).toBe(false);
	});
});

describe('regression — a SelectStmt that is not a read must be refused (R-02)', () => {
	/**
	 * The most consequential finding of Phase 2, and the counter-example to
	 * "the statement kind is the whole check".
	 *
	 * `SELECT * INTO evil FROM claims` parses as a **SelectStmt** — the kind check
	 * passes — and it CREATES A TABLE. It was PERMITTED until probed for directly.
	 * `FOR UPDATE` is the same shape: a SelectStmt that takes row locks.
	 *
	 * The Python/sqlglot implementation never needed this check, because sqlglot models
	 * SELECT INTO as its own node type. Using PostgreSQL's real parser buys byte-exact
	 * agreement with the server and inherits the real grammar's shape along with it.
	 */
	const NOT_READS: Array<[string, string]> = [
		['SELECT INTO creates a table', 'SELECT * INTO evil FROM claims'],
		['SELECT INTO with a column list', 'SELECT id INTO claims_copy FROM claims'],
		['SELECT INTO inside a CTE', 'WITH t AS (SELECT id INTO x FROM claims) SELECT id FROM t'],
		['FOR UPDATE takes row locks', 'SELECT id FROM claims FOR UPDATE'],
		['FOR SHARE takes row locks', 'SELECT id FROM claims FOR SHARE'],
		['FOR UPDATE in a subquery', 'SELECT id FROM (SELECT id FROM claims FOR UPDATE) AS s']
	];

	test.each(NOT_READS)('%s', async (_name, sql) => {
		const result = await validateSql(sql);
		expect(result.permitted).toBe(false);
		expect(result.normalisedSql).toBeNull();
	});
});

describe('regression — schema qualification on a WHITELISTED relation name (R-03)', () => {
	// `pg_catalog.pg_tables` is caught by the table check, because pg_tables is not in
	// the catalogue. A qualified name whose RELATION is whitelisted reaches further —
	// `evil.claims` passes the table check and must be stopped by the schema check.
	const QUALIFIED: Array<[string, string]> = [
		['unknown schema, whitelisted relation', 'SELECT * FROM evil.claims'],
		['pg_catalog schema, whitelisted relation', 'SELECT id FROM pg_catalog.claims'],
		['information_schema, whitelisted relation', 'SELECT id FROM information_schema.claims']
	];

	test.each(QUALIFIED)('%s', async (_name, sql) => {
		const result = await validateSql(sql);
		expect(result.permitted).toBe(false);
		expect(result.failedCheck).toBe('schema_qualified');
	});

	it('permits an explicit public qualifier', async () => {
		const result = await validateSql('SELECT id FROM public.claims');
		expect(result.permitted).toBe(true);
	});
});

describe('regression — the pg_ namespace is denied structurally, not by enumeration', () => {
	// The specification names four functions. Enumerating fails open on the fifth, so
	// the whole prefix is denied. These are functions the spec never listed.
	const UNLISTED: Array<[string, string]> = [
		['pg_ls_dir', "SELECT pg_ls_dir('/')"],
		['pg_read_binary_file', "SELECT pg_read_binary_file('/etc/passwd')"],
		['pg_stat_file', "SELECT pg_stat_file('/etc/passwd')"],
		['pg_reload_conf', 'SELECT pg_reload_conf()'],
		['current_setting', "SELECT current_setting('is_superuser')"],
		['schema-qualified pg_catalog function', "SELECT pg_catalog.pg_sleep(5)"]
	];

	test.each(UNLISTED)('rejects %s', async (_name, sql) => {
		const result = await validateSql(sql);
		expect(result.permitted).toBe(false);
	});
});
