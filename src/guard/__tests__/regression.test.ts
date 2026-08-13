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

/**
 * R-04 — the parser's own `pg_catalog` qualification (defect D-41).
 *
 * PostgreSQL canonicalises the SQL-standard special-syntax functions into explicitly
 * `pg_catalog`-qualified calls. The gate refused any qualifier but `public`, so it
 * refused standard SQL nobody wrote suspiciously — `EXTRACT` above all, which makes
 * every accident-year, development-year and seasonality question impossible to ask.
 *
 * Accepting that qualifier is a relaxation, so it is fenced from both sides here: the
 * benign forms must pass, and the dangerous ones must STILL fail through exactly the
 * same door they always did — the bare function name.
 */
describe('regression — parser-injected pg_catalog qualification (R-04)', () => {
	const STANDARD_SYNTAX: Array<[string, string]> = [
		['EXTRACT', 'SELECT EXTRACT(YEAR FROM incident_date) AS accident_year FROM claims'],
		['SUBSTRING ... FROM ... FOR', 'SELECT SUBSTRING(claim_number FROM 1 FOR 3) FROM claims'],
		['TRIM BOTH ... FROM', "SELECT TRIM(BOTH ' ' FROM claim_number) FROM claims"],
		['POSITION ... IN', "SELECT POSITION('C' IN claim_number) FROM claims"],
		['OVERLAY ... PLACING', "SELECT OVERLAY(claim_number PLACING 'X' FROM 1) FROM claims"]
	];

	test.each(STANDARD_SYNTAX)('permits %s, which the parser rewrites as pg_catalog.*', async (_name, sql) => {
		const result = await validateSql(sql);
		if (!result.permitted) {
			throw new Error(`standard SQL was REJECTED (${result.failedCheck}): ${result.reason}\n${sql}`);
		}
		expect(result.permitted).toBe(true);
	});

	/**
	 * THE fence. Every one of these is qualified with the same schema the check now
	 * accepts, and every one must still be refused — by NAME, which is where the danger
	 * always was. If a future change makes these pass, the relaxation has become one.
	 */
	const STILL_DENIED: Array<[string, string]> = [
		['pg_catalog.pg_read_file', "SELECT pg_catalog.pg_read_file('/etc/passwd')"],
		['pg_catalog.pg_ls_dir', "SELECT pg_catalog.pg_ls_dir('/')"],
		['pg_catalog.pg_sleep', 'SELECT pg_catalog.pg_sleep(5)'],
		['pg_catalog.current_setting', "SELECT pg_catalog.current_setting('is_superuser')"],
		['pg_catalog.set_config', "SELECT pg_catalog.set_config('x', 'y', false)"],
		['pg_catalog.has_table_privilege', "SELECT pg_catalog.has_table_privilege('users', 'SELECT')"]
	];

	test.each(STILL_DENIED)('still rejects %s', async (_name, sql) => {
		const result = await validateSql(sql);
		expect(result.permitted).toBe(false);
		expect(result.failedCheck).toBe('forbidden_function');
	});

	it('accepts pg_catalog as a FUNCTION qualifier but never as a TABLE one', async () => {
		// The relaxation is scoped to check 8. A relation is still refused, by the
		// catalogue check and again by the schema check behind it.
		const asRelation = await validateSql('SELECT tablename FROM pg_catalog.pg_tables');
		expect(asRelation.permitted).toBe(false);
	});

	it('rejects any other qualifier, which the parser never emits', async () => {
		const result = await validateSql("SELECT information_schema._pg_expandarray(ARRAY[1])");
		expect(result.permitted).toBe(false);
		expect(result.failedCheck).toBe('forbidden_function');
	});
});
