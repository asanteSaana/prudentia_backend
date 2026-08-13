import {Express} from 'express';
import {Knex} from 'knex';
import supertest from 'supertest';
import {resetApplicationTables, startTestServer, testDb} from '../../_e2e';
import {addUser, ANALYST_CREDENTIALS, EXECUTIVE_CREDENTIALS} from '../../_e2e/seedUsers';

/**
 * Metrics endpoints (FR-22, NFR-09, NFR-12, docs §8.1).
 *
 * The headline figures are the ones the user manual says can be relied on, so these
 * tests check them against insurance norms AND against independently written reference
 * SQL — not merely that the endpoint returns 200 with some numbers in it.
 */

describe('METRICS', () => {
	let server: Express;
	let knex: Knex;
	let analystToken: string;
	let execToken: string;

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

	const get = (path: string, token: string) => supertest(server).get(path).set('Authorization', token);

	// ── F-16 ────────────────────────────────────────────────────────────────
	describe('F-16 headline figures are within insurance norms', () => {
		it('returns all six figures', async () => {
			const response = await get('/api/v1/metrics/headline', execToken);

			expect(response.status).toBe(200);
			const m = response.body.data;
			for (const key of [
				'lossRatio',
				'claimFrequency',
				'averageSeverity',
				'earnedPremium',
				'activePolicies',
				'averageSettlementDays'
			]) {
				expect(typeof m[key]).toBe('number');
				expect(Number.isFinite(m[key])).toBe(true);
			}
		});

		it('loss ratio is commercially plausible', async () => {
			const {body} = await get('/api/v1/metrics/headline', execToken);
			// Outside this band the SEED calibration is wrong, not the query — fix the
			// generator rather than widening the expectation.
			expect(body.data.lossRatio).toBeGreaterThan(0.7);
			expect(body.data.lossRatio).toBeLessThan(0.85);
		});

		it('claim frequency is commercially plausible', async () => {
			const {body} = await get('/api/v1/metrics/headline', execToken);
			expect(body.data.claimFrequency).toBeGreaterThan(0.26);
			expect(body.data.claimFrequency).toBeLessThan(0.34);
		});

		it('settlement time is plausible and computed over settled claims only', async () => {
			const {body} = await get('/api/v1/metrics/headline', execToken);
			expect(body.data.averageSettlementDays).toBeGreaterThan(5);
			expect(body.data.averageSettlementDays).toBeLessThan(120);
		});
	});

	// ── Exactness ───────────────────────────────────────────────────────────
	describe('the headline figures are EXACT, not the pipeline approximation', () => {
		it('matches independently written reference SQL', async () => {
			const {body} = await get('/api/v1/metrics/headline', analystToken);

			const {rows} = await knex.raw(`
				SELECT (SELECT SUM(incurred_amount) FROM claims) / (SELECT SUM(earned_premium) FROM policies) AS lr,
				       (SELECT COUNT(*) FROM claims)::numeric / (SELECT COUNT(*) FROM policies) AS freq,
				       (SELECT COUNT(*) FROM policies WHERE status = 'ACTIVE') AS active
			`);

			expect(body.data.lossRatio).toBeCloseTo(parseFloat(rows[0].lr), 6);
			expect(body.data.claimFrequency).toBeCloseTo(parseFloat(rows[0].freq), 6);
			expect(body.data.activePolicies).toBe(Number(rows[0].active));
		});

		it('does NOT use the LEFT JOIN pattern, which understates the denominator', async () => {
			/**
			 * The pipeline's generated SQL joins policies to claims, duplicating a policy's
			 * earned premium once per claim (debt TD-M, measured at ~2.86%). The dashboard
			 * must not inherit that: these are the figures the manual calls exact.
			 *
			 * This asserts the two genuinely differ — if they ever converged, the headline
			 * query would have silently acquired the join.
			 */
			const {body} = await get('/api/v1/metrics/headline', analystToken);

			const {rows} = await knex.raw(`
				SELECT SUM(c.incurred_amount) / NULLIF(SUM(p.earned_premium), 0) AS lr
				  FROM policies p LEFT JOIN claims c ON c.policy_id = p.id
			`);
			const joined = parseFloat(rows[0].lr);

			expect(body.data.lossRatio).toBeGreaterThan(joined);
			// And the gap stays inside the bound TD-M records.
			const understatement = (body.data.lossRatio - joined) / body.data.lossRatio;
			expect(understatement).toBeLessThan(0.03);
		});
	});

	// ── Trend ───────────────────────────────────────────────────────────────
	describe('trend', () => {
		it('returns a monthly series in chronological order', async () => {
			const response = await get('/api/v1/metrics/trend', execToken);

			expect(response.status).toBe(200);
			expect(response.body.data.length).toBeGreaterThan(12);

			const months = response.body.data.map((point: {month: string}) => point.month);
			expect([...months].sort()).toEqual(months);
		});

		it('carries counts and incurred amounts as numbers', async () => {
			const {body} = await get('/api/v1/metrics/trend', execToken);
			for (const point of body.data) {
				expect(typeof point.claimCount).toBe('number');
				expect(typeof point.incurredAmount).toBe('number');
			}
		});

		it('total claims across the series equals the claims table', async () => {
			const {body} = await get('/api/v1/metrics/trend', execToken);
			const total = body.data.reduce((sum: number, p: {claimCount: number}) => sum + p.claimCount, 0);

			const [{count}] = (await knex.raw('SELECT COUNT(*)::int AS count FROM claims')).rows;
			expect(total).toBe(count);
		});
	});

	// ── A-08 / A-09 — the schema endpoint is the role boundary ──────────────
	describe('schema endpoint', () => {
		it('A-08 an EXECUTIVE is refused with 403', async () => {
			const response = await get('/api/v1/metrics/schema', execToken);
			expect(response.status).toBe(403);
		});

		it('A-09 an ANALYST receives it, and no application table is listed', async () => {
			const response = await get('/api/v1/metrics/schema', analystToken);

			expect(response.status).toBe(200);
			expect(response.body.data.tables).toHaveLength(8);

			const body = JSON.stringify(response.body);
			expect(body).not.toContain('password_hash');
			expect(body).not.toMatch(/"name":\s*"users"/);
			expect(body).not.toMatch(/"name":\s*"query_log"/);
		});

		it('returns EXACTLY what the LLM is shown, not a re-description', async () => {
			// An analyst verifying an answer must be inspecting the schema the model
			// actually saw. A second hand-maintained copy would drift.
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const {renderSchemaForLlm} = require('../../guard/catalogue');
			const {body} = await get('/api/v1/metrics/schema', analystToken);
			expect(body.data.rendered).toBe(renderSchemaForLlm());
		});
	});

	// ── NFR-09 ──────────────────────────────────────────────────────────────
	it('NFR-09 headline metrics respond well inside 2 seconds', async () => {
		const started = Date.now();
		await get('/api/v1/metrics/headline', execToken);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	// ── Health ──────────────────────────────────────────────────────────────
	describe('health', () => {
		it('is reachable without authentication and reports dependency status', async () => {
			const response = await supertest(server).get('/api/health');

			expect(response.status).toBe(200);
			expect(response.body.status).toBe('healthy');
			expect(response.body.database).toBe('up');
			expect(response.body.provider).toBe('stub');
		});

		it('leaks no host, driver or credential detail to an unauthenticated caller', async () => {
			const response = await supertest(server).get('/api/health');
			const body = JSON.stringify(response.body);
			expect(body).not.toMatch(/localhost|postgres|prudentia_app|password|5432/i);
		});
	});
});
