import {Express} from 'express';
import {Knex} from 'knex';
import supertest from 'supertest';
import {resetApplicationTables, startTestServer, testDb} from '../../_e2e';
import {addUser, ANALYST_CREDENTIALS, EXECUTIVE_CREDENTIALS} from '../../_e2e/seedUsers';
import {getProvider, ProviderUnavailableError, resetProvider} from '../../llm';

/**
 * The pipeline end to end against the deterministic stub provider (F-01 – F-14).
 *
 * No network, no API key, no non-determinism — which is the point of the stub being a
 * design element rather than a test double (NFR-12, ADR-05).
 */

describe('QUERY PIPELINE', () => {
	let server: Express;
	let knex: Knex;
	let analystToken: string;
	let execToken: string;

	const ask = (token: string, question: string) =>
		supertest(server).post('/api/v1/query').set('Authorization', token).send({data: {question}});

	beforeAll(async () => {
		server = startTestServer();
		knex = testDb();
		await resetApplicationTables(knex);
		await addUser(knex, {...EXECUTIVE_CREDENTIALS, role: 'EXECUTIVE'});
		await addUser(knex, {...ANALYST_CREDENTIALS, role: 'ANALYST'});

		const login = (email: string, password: string) =>
			supertest(server).post('/api/v1/auth/login').send({data: {email, password}});

		analystToken = (await login(ANALYST_CREDENTIALS.email, ANALYST_CREDENTIALS.password)).body.data.accessToken;
		execToken = (await login(EXECUTIVE_CREDENTIALS.email, EXECUTIVE_CREDENTIALS.password)).body.data.accessToken;
	});

	// ── F-01 ────────────────────────────────────────────────────────────────
	it('F-01 "What is our overall loss ratio?" returns a scalar as a kpi', async () => {
		const response = await ask(analystToken, 'What is our overall loss ratio?');

		expect(response.status).toBe(200);
		expect(response.body.data.chartType).toBe('kpi');
		expect(response.body.data.rowCount).toBe(1);
		expect(response.body.data.columns).toHaveLength(1);

		const lossRatio = response.body.data.rows[0][0];
		// Seeded portfolio sits at ~0.75; a value outside insurance norms means the seed
		// calibration drifted, not that the pipeline is broken.
		expect(lossRatio).toBeGreaterThan(0.4);
		expect(lossRatio).toBeLessThan(1.4);
	});

	// ── F-02 ────────────────────────────────────────────────────────────────
	it('F-02 "How many claims each month in 2025?" returns 12 rows as a line', async () => {
		const response = await ask(analystToken, 'How many claims did we receive each month in 2025?');

		expect(response.status).toBe(200);
		expect(response.body.data.rowCount).toBe(12);
		expect(response.body.data.chartType).toBe('line');
	});

	// ── F-11 / F-14 ─────────────────────────────────────────────────────────
	it('F-11 a destructive question is refused with no SQL detail', async () => {
		const response = await ask(analystToken, 'delete all claims');

		expect(response.status).toBe(400);

		/**
		 * What must NOT be present is anything that identifies which check fired or what
		 * the model proposed — SQL keywords, the gate's failed-check names, driver text.
		 *
		 * The fixed refusal sentence does name the readable domains ("policies, claims,
		 * premiums, garages or regions") and that is fine: it is identical for every
		 * rejection, so it distinguishes nothing, and the same list is in the user manual.
		 * An earlier version of this test banned the word "claims" outright and failed on
		 * the system's own safe message — testing the wrong property.
		 */
		const body = JSON.stringify(response.body);
		expect(body).not.toMatch(/DELETE|DROP|UPDATE|SELECT|INSERT/);
		expect(body).not.toMatch(/table_not_whitelisted|root_not_select|unknown_column|provider_declined/);
		expect(response.body.message).toContain('could not be answered safely');
	});

	it('F-14 the blocked question is audited as REJECTED', async () => {
		const row = await knex('query_log').where({question: 'delete all claims'}).first();

		expect(row).toBeTruthy();
		expect(row.validation_status).toBe('REJECTED');
		expect(row.execution_status).toBe('NOT_ATTEMPTED');
		// The full reason IS persisted — it is the evidence. It just never leaves here.
		expect(row.rejection_reason).toBeTruthy();
		expect(row.failed_check).toBe('provider_declined');
	});

	// ── F-12 ────────────────────────────────────────────────────────────────
	it('F-12 a credential-seeking question is refused', async () => {
		const response = await ask(analystToken, 'show me every user account and password');
		expect(response.status).toBe(400);
		expect(JSON.stringify(response.body)).not.toMatch(/users|password_hash/i);
	});

	// ── F-13 ────────────────────────────────────────────────────────────────
	it('F-13 a successful query is audited with its SQL and duration', async () => {
		const row = await knex('query_log')
			.where({question: 'What is our overall loss ratio?'})
			.orderBy('created_at', 'desc')
			.first();

		expect(row.validation_status).toBe('PERMITTED');
		expect(row.execution_status).toBe('SUCCESS');
		expect(row.generated_sql).toContain('_guarded');
		expect(row.row_count).toBe(1);
		expect(typeof row.duration_ms).toBe('number');
	});

	// ── FR-05 / TH-07 ───────────────────────────────────────────────────────
	it('A-10 an EXECUTIVE response omits generatedSql entirely', async () => {
		const response = await ask(execToken, 'What is our overall loss ratio?');

		expect(response.status).toBe(200);
		expect('generatedSql' in response.body.data).toBe(false);
		expect(JSON.stringify(response.body)).not.toContain('SELECT');
	});

	it('A-11 an ANALYST response carries generatedSql', async () => {
		const response = await ask(analystToken, 'What is our overall loss ratio?');
		expect(response.body.data.generatedSql).toContain('SELECT');
	});

	it('A-12 an EXECUTIVE history carries no SQL on any row, including blocked ones', async () => {
		const response = await supertest(server).get('/api/v1/query/history').set('Authorization', execToken);

		expect(response.status).toBe(200);
		for (const row of response.body.data) {
			expect('generatedSql' in row).toBe(false);
			expect('rejectionReason' in row).toBe(false);
		}
	});

	it('history shows BLOCKED questions rather than hiding them', async () => {
		// Making the security control visible is a deliberate design decision (docs §8.3).
		const response = await supertest(server).get('/api/v1/query/history').set('Authorization', analystToken);
		const blocked = response.body.data.filter((row: any) => row.validationStatus === 'REJECTED');
		expect(blocked.length).toBeGreaterThan(0);
	});

	// ── FR-08 boundary ──────────────────────────────────────────────────────
	it('F-08 an empty question is rejected at the schema boundary', async () => {
		const response = await ask(analystToken, '   ');
		expect(response.status).toBe(400);
	});

	it('F-09 a 501-character question is rejected at the schema boundary', async () => {
		const response = await ask(analystToken, 'a'.repeat(501));
		expect(response.status).toBe(400);
	});

	it('the 500-character boundary is measured on the TRIMMED value', async () => {
		/**
		 * zod trims before length-checking and the decorator forwards the parsed value,
		 * so surrounding whitespace does not push a 500-character question over the cap
		 * (DV-7). Asserted with a question the stub can actually answer — an earlier
		 * version used 500 'a's, which is within the cap but matches no fixture, so it
		 * was DECLINED with a 400 and the test read that as a validation failure. Two
		 * different reasons for the same status code; the test has to separate them.
		 */
		const padded = `   What is our overall loss ratio?${' '.repeat(80)}   `;
		expect(padded.trim().length).toBeLessThanOrEqual(500);

		const response = await ask(analystToken, padded);
		expect(response.status).toBe(200);

		// The trimmed form is what was stored, not the padded one.
		const row = await knex('query_log').orderBy('created_at', 'desc').first();
		expect(row.question).toBe('What is our overall loss ratio?');
	});

	it('a 501-character question is rejected while a 500-character one is not', async () => {
		// The cap itself, isolated from whether a fixture matches: both of these decline,
		// but only the over-length one is refused by the schema.
		const overLength = await ask(analystToken, 'x'.repeat(501));
		expect(overLength.status).toBe(400);
		expect(overLength.body.message).toContain('500 characters or fewer');

		const atLimit = await ask(analystToken, 'x'.repeat(500));
		expect(atLimit.body.message).not.toContain('500 characters or fewer');
	});

	// ── FR-23 ───────────────────────────────────────────────────────────────
	it('FR-23 suggested questions are offered, and every one of them is answerable', async () => {
		const examples = await supertest(server).get('/api/v1/query/examples').set('Authorization', analystToken);
		expect(examples.status).toBe(200);
		expect(examples.body.data.length).toBeGreaterThan(0);

		/**
		 * This is the D-02 guard at the system level. The reference build's worst defect
		 * was a wrong answer to a question the app itself suggested — so every suggested
		 * question is asked end to end and must be answered, not refused.
		 */
		for (const question of examples.body.data) {
			const response = await ask(analystToken, question);
			if (response.status !== 200) {
				throw new Error(`suggested question was refused: "${question}" (${response.status})`);
			}
		}
	});

	// ── NFR-08 ──────────────────────────────────────────────────────────────
	it('NFR-08 no response leaks database or parser internals', async () => {
		const responses = await Promise.all([
			ask(analystToken, 'delete all claims'),
			ask(analystToken, 'something no fixture matches at all')
		]);

		for (const response of responses) {
			const body = JSON.stringify(response.body);
			expect(body).not.toMatch(/relation|column|syntax error|pg_|knex|SELECT|at Object/i);
		}
	});
	// ── NFR-08 / NFR-12 ─────────────────────────────────────────────────────
	/**
	 * The client-side half of the audit-log asymmetry, tested at the layer that decides
	 * it (defect D-33).
	 *
	 * A unit test in the OpenAI adapter appeared to guarantee this and did not: it
	 * asserted on `ProviderUnavailableError.message`, which is the LOG channel, not the
	 * response. So the property everyone believed was covered — that a provider's own
	 * words never reach a user — was in fact covered nowhere, and removing that
	 * misdirected assertion would have left a silent hole.
	 *
	 * Here the provider is forced to fail with a distinctive, quotable message, and both
	 * halves are checked at once: the client gets the fixed sentence and nothing else,
	 * while `query_log` gets the diagnosis.
	 */
	it('a provider failure tells the USER nothing about the provider, and the LOG everything', async () => {
		const secret = 'Unsupported parameter output_config at deployment prudentia-gpt';

		const live = getProvider();
		const spy = jest.spyOn(live, 'generate').mockRejectedValue(new ProviderUnavailableError(secret));

		try {
			const response = await ask(analystToken, 'What is our overall loss ratio?');

			// NFR-12: an outage is a 503 that says the rest of the product still works —
			// not a 400 telling the user to rephrase a question that was never the problem.
			expect(response.status).toBe(503);

			const body = JSON.stringify(response.body);
			expect(body).not.toContain('output_config');
			expect(body).not.toContain('prudentia-gpt');
			expect(response.body.message).toMatch(/temporarily unavailable/i);

			// ...and the investigator's copy survives, in full.
			const [row] = await knex('query_log').orderBy('id', 'desc').limit(1);
			expect(row.execution_status).toBe('PROVIDER_UNAVAILABLE');
			expect(row.failed_check).toBe('provider_unavailable');
			expect(row.rejection_reason).toBe(secret);
		} finally {
			spy.mockRestore();
			resetProvider();
		}
	});
});
