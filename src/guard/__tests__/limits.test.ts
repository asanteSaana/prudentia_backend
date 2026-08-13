import {loadModule, parseSync} from 'libpg-query';
import {MAX_ROWS, validateSql} from '../validator';

/**
 * Row-ceiling enforcement (FR-13, CLAUDE.md §4 rule 3).
 *
 * The ceiling is applied by WRAPPING the validated statement:
 *
 *     SELECT * FROM ( <validated sql> ) AS _guarded LIMIT 1000
 *
 * never by rewriting the string. `libpg-query` has no deparser, so mutating the AST and
 * re-emitting is not available — and that constraint turns out to be a feature: the
 * validated text is never altered, so what executes is exactly what was proven safe,
 * plus an outer bound.
 *
 * A smaller inner LIMIT still wins naturally, so injection, capping and preservation
 * are ONE code path with no conditionals. These tests exist to prove that claim rather
 * than to exercise three branches.
 */

beforeAll(async () => {
	await loadModule();
});

describe('row ceiling', () => {
	it('injects a ceiling when the statement has none', async () => {
		const result = await validateSql('SELECT claim_number FROM claims');

		expect(result.permitted).toBe(true);
		expect(result.normalisedSql).toContain('_guarded');
		expect(result.normalisedSql).toContain(`LIMIT ${MAX_ROWS}`);
	});

	it('caps a statement asking for more than the ceiling', async () => {
		const result = await validateSql('SELECT claim_number FROM claims LIMIT 999999');

		expect(result.permitted).toBe(true);
		// The inner LIMIT is preserved verbatim — the outer wrapper is what binds.
		expect(result.normalisedSql).toContain('999999');
		expect(result.normalisedSql).toContain(`LIMIT ${MAX_ROWS}`);
	});

	it('preserves a smaller inner limit, which wins naturally', async () => {
		const result = await validateSql('SELECT claim_number FROM claims LIMIT 5');

		expect(result.permitted).toBe(true);
		expect(result.normalisedSql).toContain('LIMIT 5');
		expect(result.normalisedSql).toContain(`LIMIT ${MAX_ROWS}`);
	});

	it('re-parses the wrapped statement and confirms it is still exactly one SelectStmt', async () => {
		// The wrap must not be able to change what the statement IS. If wrapping could
		// turn a permitted statement into something else, the proof would be void.
		const result = await validateSql(
			`SELECT r.name, COUNT(*) AS n
			   FROM claims c
			   JOIN policies p ON p.id = c.policy_id
			   JOIN customers cu ON cu.id = p.customer_id
			   JOIN regions r ON r.id = cu.region_id
			  GROUP BY r.name`
		);

		expect(result.permitted).toBe(true);
		const parsed = parseSync(result.normalisedSql as string) as {stmts: Array<{stmt: Record<string, unknown>}>};
		expect(parsed.stmts).toHaveLength(1);
		expect(Object.keys(parsed.stmts[0].stmt)[0]).toBe('SelectStmt');
	});

	it('rejects rather than wraps when the inner statement is not permitted', async () => {
		const result = await validateSql('SELECT * FROM users');

		expect(result.permitted).toBe(false);
		expect(result.normalisedSql).toBeNull();
	});

	it('strips a trailing semicolon before wrapping', async () => {
		// A trailing semicolon is legitimate and common from a model. Wrapping without
		// removing it produces `SELECT * FROM (SELECT ...;) AS _guarded`, which does not
		// parse — turning a valid question into an unexplained failure.
		const result = await validateSql('SELECT claim_number FROM claims;');

		expect(result.permitted).toBe(true);
		expect(result.normalisedSql).not.toContain(';');
	});
});
