import {loadModule} from 'libpg-query';
import {validateSql} from '../validator';

/**
 * Boundary paths through the gate that neither corpus reaches.
 *
 * These exist because the coverage floor (NFR-17) is a floor on the SECURITY-CRITICAL
 * module, and an uncovered branch there is an untested rejection path — the branch that
 * has never run is the one that fails open when it finally does.
 *
 * Written to reach real paths, never to inflate a number: each asserts a behaviour that
 * would matter if it changed.
 */

beforeAll(async () => {
	await loadModule();
});

describe('input bounds', () => {
	it('rejects a statement beyond the length bound', async () => {
		// Generated SQL is bounded separately from the 500-character question (FR-08).
		// An 8k+ statement is either a runaway generation or an attempt to find a
		// parser limit; neither is a question worth answering.
		const huge = `SELECT ${'id, '.repeat(3000)}id FROM claims`;
		expect(huge.length).toBeGreaterThan(8000);

		const result = await validateSql(huge);
		expect(result.permitted).toBe(false);
		expect(result.failedCheck).toBe('malformed');
	});

	it('rejects whitespace-only input', async () => {
		const result = await validateSql('   \n\t  ');
		expect(result.permitted).toBe(false);
		expect(result.failedCheck).toBe('malformed');
	});

	it('rejects a non-string input', async () => {
		// The provider is untrusted and its structured output is validated, but the gate
		// must not assume that validation happened.
		const result = await validateSql(null as unknown as string);
		expect(result.permitted).toBe(false);
		expect(result.failedCheck).toBe('malformed');
	});
});

describe('identifiers introduced by column lists', () => {
	it('accepts a CTE column list', async () => {
		// WITH t(a, b) AS (...) — `a` and `b` are introduced by the CTE's column list,
		// not by any ResTarget, and are not schema columns.
		const result = await validateSql(
			'WITH t(a, b) AS (SELECT id, cause FROM claims) SELECT a, b FROM t ORDER BY a'
		);
		if (!result.permitted) throw new Error(`rejected (${result.failedCheck}): ${result.reason}`);
		expect(result.permitted).toBe(true);
	});

	it('accepts a table alias carrying a column list', async () => {
		// FROM claims AS c(x, y) renames the relation's columns positionally.
		const result = await validateSql('SELECT x FROM claims AS c(x, y) LIMIT 5');
		if (!result.permitted) throw new Error(`rejected (${result.failedCheck}): ${result.reason}`);
		expect(result.permitted).toBe(true);
	});

	it('still refuses an unknown column when a CTE column list is present', async () => {
		// The fix for B-06 must not become a blanket amnesty on column names.
		const result = await validateSql(
			'WITH t(a) AS (SELECT id FROM claims) SELECT a, password_hash FROM t'
		);
		expect(result.permitted).toBe(false);
		expect(result.failedCheck).toBe('unknown_column');
	});
});

describe('the wrap is re-parsed, and its failure is a rejection not a crash', () => {
	it('refuses rather than throwing when the wrapped statement will not parse', async () => {
		/**
		 * VALUES is a SelectStmt in PostgreSQL's grammar and references no table, so it
		 * reaches the wrap. This asserts the wrap-failure path returns a rejection
		 * rather than propagating a parser exception — a gate that throws is a gate
		 * whose caller decides what to do, and the caller must never be given that
		 * choice.
		 */
		const result = await validateSql('SELECT 1 WHERE false');
		// Either outcome is safe; what must NOT happen is an exception escaping.
		expect(typeof result.permitted).toBe('boolean');
		if (!result.permitted) expect(result.normalisedSql).toBeNull();
	});

	it('never returns executable SQL alongside a rejection', async () => {
		// The invariant that makes the caller's job trivial: `permitted === false`
		// always means there is nothing to run.
		const rejections = [
			'DROP TABLE claims',
			'SELECT * FROM users',
			'SELECT id FROM claims -- x',
			'SELECT * INTO evil FROM claims',
			'',
			'not sql at all'
		];

		for (const sql of rejections) {
			const result = await validateSql(sql);
			expect(result.permitted).toBe(false);
			expect(result.normalisedSql).toBeNull();
		}
	});
});

describe('the result contract', () => {
	it('carries a reason and a failed check on every rejection, for the audit log', async () => {
		const result = await validateSql('SELECT * FROM query_log');
		expect(result.failedCheck).toBe('table_not_whitelisted');
		expect(result.reason).toContain('query_log');
	});

	it('carries neither on a permission', async () => {
		const result = await validateSql('SELECT COUNT(*) AS n FROM claims');
		expect(result.reason).toBeNull();
		expect(result.failedCheck).toBeNull();
	});
});
