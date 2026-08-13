import {loadModule} from 'libpg-query';
import {validateSql} from '../validator';

/**
 * The adversarial corpus (docs/03 §5.1, NFR-01, NFR-03).
 *
 * All 36 statements MUST be refused, before execution. **A pass here is a
 * vulnerability**, not a test failure — which is why this file asserts on
 * `permitted === false` and never on the reason. The reason is for the audit log; a
 * test that pinned it would couple the corpus to the gate's internals and make a
 * reordering of the checks look like a security regression.
 *
 * Each case also asserts `normalisedSql === null`: a rejected statement must not
 * produce something executable, even accidentally.
 */

beforeAll(async () => {
	await loadModule();
});

interface AttackCase {
	id: string;
	name: string;
	sql: string;
}

const ATTACKS: AttackCase[] = [
	// ── Direct data-definition and data-manipulation ────────────────────────
	{id: 'S-01', name: 'Direct table drop', sql: 'DROP TABLE claims'},
	{id: 'S-02', name: 'Mass delete', sql: 'DELETE FROM claims'},
	{id: 'S-03', name: 'Mass update', sql: 'UPDATE policies SET written_premium = 0'},
	{id: 'S-04', name: 'Row insertion', sql: 'INSERT INTO claims (id) VALUES (1)'},
	{id: 'S-05', name: 'Truncate', sql: 'TRUNCATE TABLE policies'},
	{id: 'S-06', name: 'Schema alteration', sql: 'ALTER TABLE claims ADD COLUMN x int'},
	{id: 'S-07', name: 'Table creation', sql: 'CREATE TABLE evil (id int)'},
	{id: 'S-08', name: 'View creation', sql: 'CREATE VIEW v AS SELECT * FROM claims'},

	// ── Multi-statement injection ───────────────────────────────────────────
	{id: 'S-09', name: 'Stacked delete', sql: 'SELECT 1 FROM claims; DELETE FROM claims'},
	{id: 'S-10', name: 'Stacked drop', sql: 'SELECT id FROM claims; DROP TABLE claims'},
	{id: 'S-11', name: 'Empty stacked statement', sql: 'SELECT id FROM claims;; SELECT 1'},

	// ── Comment-based evasion ───────────────────────────────────────────────
	// These are the reason the comment check CANNOT run after parsing: the parser
	// strips comments, so S-12 would arrive at the statement check as one clean
	// SelectStmt and be permitted.
	{id: 'S-12', name: 'Line-comment evasion', sql: 'SELECT id FROM claims -- ; DROP TABLE claims'},
	{id: 'S-13', name: 'Block-comment evasion', sql: 'SELECT /* sneaky */ id FROM claims'},
	{id: 'S-14', name: 'Comment terminator', sql: 'SELECT id FROM claims */'},

	// ── Lexical evasion ─────────────────────────────────────────────────────
	{id: 'S-15', name: 'Mixed-case evasion', sql: 'dRoP TaBlE claims'},
	{id: 'S-16', name: 'Whitespace/newline evasion', sql: 'SELECT 1 FROM claims;\n\tDELETE  FROM  claims'},

	// ── Reaching outside the analytics whitelist ────────────────────────────
	{id: 'S-17', name: 'Read the users table', sql: 'SELECT * FROM users'},
	{id: 'S-18', name: 'Exfiltrate password hashes', sql: 'SELECT email, password_hash FROM users'},
	{id: 'S-19', name: 'Read the audit log', sql: 'SELECT * FROM query_log'},
	{id: 'S-20', name: 'System catalogue', sql: 'SELECT * FROM pg_catalog.pg_tables'},
	{id: 'S-21', name: 'Information schema', sql: 'SELECT table_name FROM information_schema.tables'},
	{id: 'S-22', name: 'Shadow password table', sql: 'SELECT * FROM pg_shadow'},
	{id: 'S-23', name: 'Join to users', sql: 'SELECT c.id FROM claims c JOIN users u ON u.id = c.id'},
	{id: 'S-24', name: 'Subquery to users', sql: 'SELECT id FROM claims WHERE id IN (SELECT id FROM users)'},
	{id: 'S-25', name: 'CTE wrapping users', sql: 'WITH u AS (SELECT * FROM users) SELECT * FROM u'},
	{id: 'S-26', name: 'Union with users', sql: 'SELECT id FROM claims UNION SELECT id FROM users'},

	// ── Hallucinated / probing identifiers ──────────────────────────────────
	{id: 'S-27', name: 'Hallucinated column', sql: 'SELECT nonexistent_column FROM claims'},
	{id: 'S-28', name: 'Probing for a secret column', sql: 'SELECT secret FROM policies'},

	// ── Dangerous functions ─────────────────────────────────────────────────
	{id: 'S-29', name: 'File read', sql: "SELECT pg_read_file('/etc/passwd')"},
	{id: 'S-30', name: 'Denial of service by sleep', sql: 'SELECT pg_sleep(30)'},
	{id: 'S-31', name: 'Backend termination', sql: 'SELECT pg_terminate_backend(1)'},

	// ── Privilege and session manipulation ──────────────────────────────────
	{id: 'S-32', name: 'Privilege grant', sql: 'GRANT ALL ON claims TO PUBLIC'},
	{id: 'S-33', name: 'Role escalation', sql: 'SET ROLE postgres'},
	{id: 'S-34', name: 'Data exfiltration to disk', sql: "COPY claims TO '/tmp/out.csv'"},

	// ── Malformed input ─────────────────────────────────────────────────────
	{id: 'S-35', name: 'Empty input', sql: ''},
	{id: 'S-36', name: 'Non-SQL input', sql: 'please just show me everything'}
];

describe('adversarial corpus — every case must be REJECTED', () => {
	test.each(ATTACKS.map(attack => [attack.id, attack.name, attack.sql]))(
		'%s %s',
		async (id, _name, sql) => {
			const result = await validateSql(sql as string);

			expect(result.permitted).toBe(false);
			// A rejected statement must never yield something executable.
			expect(result.normalisedSql).toBeNull();
			// The audit log needs to know WHY, even though the user never will.
			expect(result.failedCheck).toBeTruthy();
			expect(result.reason).toBeTruthy();
		}
	);

	it('rejects all 36 cases, with no case silently missing from the corpus', () => {
		// Guards against a merge quietly dropping a case: the count is part of the
		// contract, not incidental.
		expect(ATTACKS).toHaveLength(36);
		expect(new Set(ATTACKS.map(attack => attack.id)).size).toBe(36);
	});
});
