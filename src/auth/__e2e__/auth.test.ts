import {addMinutes, subMinutes} from 'date-fns';
import {Express} from 'express';
import {Knex} from 'knex';
import nJwt from 'njwt';
import supertest from 'supertest';
import {Constants} from '../../_services/_constants';
import {resetApplicationTables, startTestServer, testDb} from '../../_e2e';
import {addUser, ANALYST_CREDENTIALS, EXECUTIVE_CREDENTIALS} from '../../_e2e/seedUsers';

/**
 * Authentication and authorisation (docs/03 §5.3, cases A-01 – A-13).
 *
 * FR-01 – FR-07, NFR-06, TH-06, TH-07, TH-08.
 */

describe('AUTH', () => {
	let server: Express;
	let knex: Knex;

	beforeAll(async () => {
		server = startTestServer();
		knex = testDb();
		await resetApplicationTables(knex);
		await addUser(knex, {...EXECUTIVE_CREDENTIALS, role: 'EXECUTIVE'});
		await addUser(knex, {...ANALYST_CREDENTIALS, role: 'ANALYST'});
		await addUser(knex, {email: 'disabled@prudentia.demo', password: 'Disabled#2026', role: 'ANALYST', isActive: false});
	});

	const login = (email: string, password: string) =>
		supertest(server).post('/api/v1/auth/login').send({data: {email, password}});

	const authed = (token: string) => supertest(server).get('/api/v1/auth/me').set('Authorization', token);

	// ── A-01 ────────────────────────────────────────────────────────────────
	it('A-01 valid credentials return 200, a token and the role', async () => {
		const response = await login(EXECUTIVE_CREDENTIALS.email, EXECUTIVE_CREDENTIALS.password);

		expect(response.status).toBe(200);
		expect(response.body.data.accessToken).toBeTruthy();
		expect(response.body.data.role).toBe('EXECUTIVE');
		// The response must never echo anything password-shaped.
		expect(JSON.stringify(response.body)).not.toContain('password');
	});

	// ── A-02 ────────────────────────────────────────────────────────────────
	it('A-02 wrong password returns 401', async () => {
		const response = await login(EXECUTIVE_CREDENTIALS.email, 'wrong-password');
		expect(response.status).toBe(401);
	});

	// ── A-03 ────────────────────────────────────────────────────────────────
	it('A-03 unknown account and wrong password are byte-identical (TH-08)', async () => {
		const unknown = await login('nobody@prudentia.demo', 'whatever');
		const wrongPassword = await login(EXECUTIVE_CREDENTIALS.email, 'whatever');

		expect(unknown.status).toBe(wrongPassword.status);
		// Byte-identical, not merely "both 401". A different message would enumerate
		// which addresses hold accounts.
		expect(JSON.stringify(unknown.body)).toBe(JSON.stringify(wrongPassword.body));
	});

	it('A-03b a disabled account is indistinguishable from a wrong password', async () => {
		const disabled = await login('disabled@prudentia.demo', 'Disabled#2026');
		const wrongPassword = await login(EXECUTIVE_CREDENTIALS.email, 'whatever');

		expect(disabled.status).toBe(wrongPassword.status);
		expect(JSON.stringify(disabled.body)).toBe(JSON.stringify(wrongPassword.body));
	});

	// ── A-04 ────────────────────────────────────────────────────────────────
	it('A-04 a protected route without a token returns 401', async () => {
		const response = await supertest(server).get('/api/v1/auth/me');
		expect(response.status).toBe(401);
	});

	// ── A-05 ────────────────────────────────────────────────────────────────
	it.each([
		['empty', ''],
		['not a jwt', 'garbage'],
		['two segments', 'aaa.bbb'],
		['bearer with nothing', 'Bearer '],
		['tampered payload', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5OTkifQ.signature']
	])('A-05 malformed token (%s) returns 401', async (_name, token) => {
		const response = await authed(token);
		expect(response.status).toBe(401);
	});

	// ── A-06 ────────────────────────────────────────────────────────────────
	it('A-06 a token signed with the wrong secret returns 401 (TH-06)', async () => {
		const forged = nJwt.create(
			{sub: '1', email: EXECUTIVE_CREDENTIALS.email, role: 'ANALYST', iss: 'prudentia-api'},
			'not-the-real-signing-key'
		);
		forged.setExpiration(addMinutes(new Date(), 60));

		const response = await authed(forged.compact());
		expect(response.status).toBe(401);
	});

	it('A-06b a token from another issuer with the RIGHT secret returns 401', async () => {
		// njwt verifies the signature and expiry but does not care who issued the token.
		// A sibling service sharing this signing key would otherwise authenticate here.
		const foreign = nJwt.create(
			{sub: '1', email: EXECUTIVE_CREDENTIALS.email, role: 'ANALYST', iss: 'some-other-service'},
			Constants.AUTH_JWT_KEY as string
		);
		foreign.setExpiration(addMinutes(new Date(), 60));

		const response = await authed(foreign.compact());
		expect(response.status).toBe(401);
	});

	// ── A-07 ────────────────────────────────────────────────────────────────
	it('A-07 an expired token returns 401 (NFR-06)', async () => {
		const users = await knex('users').where({email: EXECUTIVE_CREDENTIALS.email}).first();
		const expired = nJwt.create(
			{sub: String(users.id), email: users.email, role: users.role, iss: 'prudentia-api'},
			Constants.AUTH_JWT_KEY as string
		);
		expired.setExpiration(subMinutes(new Date(), 1));

		const response = await authed(expired.compact());
		expect(response.status).toBe(401);
	});

	it('A-07b an issued token expires within 60 minutes', async () => {
		const response = await login(ANALYST_CREDENTIALS.email, ANALYST_CREDENTIALS.password);
		const expiresAt = new Date(response.body.data.expiresAt).getTime();
		const ceiling = addMinutes(new Date(), Constants.JWT_EXPIRY_MINUTES + 1).getTime();

		expect(expiresAt).toBeLessThanOrEqual(ceiling);
		expect(Constants.JWT_EXPIRY_MINUTES).toBeLessThanOrEqual(60);
	});

	// ── A-08 / A-09 — role boundary, both directions ────────────────────────
	it('A-08/A-09 an executive keeps its own role and an analyst keeps its own', async () => {
		const exec = await login(EXECUTIVE_CREDENTIALS.email, EXECUTIVE_CREDENTIALS.password);
		const analyst = await login(ANALYST_CREDENTIALS.email, ANALYST_CREDENTIALS.password);

		const execMe = await authed(exec.body.data.accessToken);
		const analystMe = await authed(analyst.body.data.accessToken);

		expect(execMe.body.data.role).toBe('EXECUTIVE');
		expect(analystMe.body.data.role).toBe('ANALYST');
	});

	it('A-08b a role claim edited in the token cannot escalate (TH-07)', async () => {
		/**
		 * The privilege-escalation case that matters. The role travels in the token, but
		 * the server re-reads the user row rather than trusting the claim — so a token
		 * that is otherwise perfectly valid, signed with the real key and merely
		 * *claiming* ANALYST, still resolves to the executive's real role.
		 */
		const users = await knex('users').where({email: EXECUTIVE_CREDENTIALS.email}).first();
		const escalated = nJwt.create(
			{sub: String(users.id), email: users.email, role: 'ANALYST', iss: 'prudentia-api'},
			Constants.AUTH_JWT_KEY as string
		);
		escalated.setExpiration(addMinutes(new Date(), 60));

		const response = await authed(escalated.compact());
		expect(response.status).toBe(200);
		expect(response.body.data.role).toBe('EXECUTIVE');
	});

	it('A-09b deactivating a user takes effect immediately, without waiting for expiry', async () => {
		const session = await login(ANALYST_CREDENTIALS.email, ANALYST_CREDENTIALS.password);
		const token = session.body.data.accessToken;

		expect((await authed(token)).status).toBe(200);

		await knex('users').where({email: ANALYST_CREDENTIALS.email}).update({is_active: false});
		expect((await authed(token)).status).toBe(401);

		await knex('users').where({email: ANALYST_CREDENTIALS.email}).update({is_active: true});
	});

	// ── A-13 ────────────────────────────────────────────────────────────────
	it('A-13 passwords are stored hashed, salted and irreversibly', async () => {
		const rows = await knex('users').select('email', 'password_hash');

		for (const row of rows) {
			// scrypt, stored as `${salt}.${hash}` (DV-6 — the spec names bcrypt/$2b$;
			// this asserts what is actually built).
			expect(row.password_hash).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{128}$/);
			expect(row.password_hash).not.toContain('Executive#2026');
			expect(row.password_hash).not.toContain('Analyst#2026');
		}

		// Distinct per-user salts: two accounts must not share a hash prefix.
		const salts = rows.map((row: {password_hash: string}) => row.password_hash.split('.')[0]);
		expect(new Set(salts).size).toBe(salts.length);
	});

	// ── FR-07 ───────────────────────────────────────────────────────────────
	it('FR-07 logout succeeds for an authenticated caller', async () => {
		const session = await login(EXECUTIVE_CREDENTIALS.email, EXECUTIVE_CREDENTIALS.password);
		const response = await supertest(server)
			.post('/api/v1/auth/logout')
			.set('Authorization', session.body.data.accessToken)
			.send({data: {}});

		expect(response.status).toBe(200);
	});

	// ── NFR-07 / NFR-08 ─────────────────────────────────────────────────────
	it('NFR-07 a malformed payload is rejected at the boundary', async () => {
		const response = await supertest(server).post('/api/v1/auth/login').send({data: {email: 'not-an-email'}});
		expect(response.status).toBe(400);
	});

	it('NFR-08 no error response leaks internal detail', async () => {
		const response = await login('nobody@prudentia.demo', 'whatever');
		const body = JSON.stringify(response.body);

		expect(body).not.toMatch(/password_hash|scrypt|users|knex|pg|stack|at Object/i);
	});
});
