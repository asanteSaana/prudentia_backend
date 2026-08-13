import {projectForRole, projectListForRole} from '../roleView';

/**
 * FR-05 / TH-07 — the analyst-only fields must be ABSENT from an executive's payload.
 *
 * These assert on `in` and on the SERIALISED JSON, never on the value. A test written
 * as `expect(payload.generatedSql).toBeUndefined()` passes for a key that is present
 * and set to `undefined` — which serialises away in `JSON.stringify` but survives in
 * any other transport, and tells the next reader the key is optional rather than
 * forbidden.
 */

const RESPONSE = {
	question: 'What is our overall loss ratio?',
	rows: [[0.752]],
	chartType: 'kpi' as const,
	generatedSql: 'SELECT SUM(incurred_amount) / SUM(earned_premium) FROM claims',
	failedCheck: null,
	rejectionReason: null
};

describe('EXECUTIVE projection', () => {
	const projected = projectForRole(RESPONSE, 'EXECUTIVE');

	it('omits generatedSql entirely — the key is absent, not null', () => {
		expect('generatedSql' in projected).toBe(false);
		expect(Object.keys(projected)).not.toContain('generatedSql');
	});

	it('omits failedCheck and rejectionReason', () => {
		expect('failedCheck' in projected).toBe(false);
		expect('rejectionReason' in projected).toBe(false);
	});

	it('is absent from the serialised JSON, which is what actually reaches the client', () => {
		const json = JSON.stringify(projected);
		expect(json).not.toContain('generatedSql');
		expect(json).not.toContain('SELECT');
		expect(json).not.toContain('failedCheck');
	});

	it('keeps everything the executive is entitled to', () => {
		expect(projected.question).toBe(RESPONSE.question);
		expect(projected.rows).toEqual(RESPONSE.rows);
		expect(projected.chartType).toBe('kpi');
	});

	it('does not mutate the source — the audit log keeps the full record', () => {
		// ADR-07/NFR-15: the audit trail must retain the SQL and the failed check even
		// when the requesting user may not see them.
		expect(RESPONSE.generatedSql).toContain('SELECT');
		expect(RESPONSE.failedCheck).toBeNull();
	});
});

describe('ANALYST projection', () => {
	const projected = projectForRole(RESPONSE, 'ANALYST');

	it('retains generatedSql', () => {
		expect('generatedSql' in projected).toBe(true);
		expect(projected.generatedSql).toBe(RESPONSE.generatedSql);
	});

	it('retains the rejection detail', () => {
		expect('failedCheck' in projected).toBe(true);
		expect('rejectionReason' in projected).toBe(true);
	});
});

describe('history projection (FR-25)', () => {
	const history = [
		{question: 'a', generatedSql: 'SELECT 1', failedCheck: null, rejectionReason: null},
		{question: 'b', generatedSql: null, failedCheck: 'table_not_whitelisted', rejectionReason: 'users'}
	];

	it('strips every row for an executive, including the blocked one', () => {
		// A-12. The BLOCKED row is the one that matters: its rejectionReason names the
		// table that was reached for, which is exactly the oracle §4 rule 7 forbids.
		const projected = projectListForRole(history, 'EXECUTIVE');
		for (const row of projected) {
			expect('generatedSql' in row).toBe(false);
			expect('failedCheck' in row).toBe(false);
			expect('rejectionReason' in row).toBe(false);
		}
		expect(JSON.stringify(projected)).not.toContain('users');
	});

	it('retains every row for an analyst', () => {
		const projected = projectListForRole(history, 'ANALYST');
		expect(projected[0].generatedSql).toBe('SELECT 1');
		expect(projected[1].failedCheck).toBe('table_not_whitelisted');
	});
});
