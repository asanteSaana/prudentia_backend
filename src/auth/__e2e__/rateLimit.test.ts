import {Express} from 'express';
import supertest from 'supertest';
import {resetApplicationTables, testDb} from '../../_e2e';
import {addUser, EXECUTIVE_CREDENTIALS} from '../../_e2e/seedUsers';

/**
 * FR-18 / TH-08 — the rate limiter actually fires.
 *
 * The suite runs with the limits raised (`.env.test` sets 1000) so dozens of legitimate
 * logins from one address do not throttle unrelated tests. That raise creates a hazard
 * this file exists to close: **a limiter whose threshold no test can reach is a limiter
 * nobody has verified.**
 *
 * So this file rebuilds the module graph with a low limit via `jest.resetModules`,
 * exercising the real `express-rate-limit` middleware, the real key generator and the
 * real 429 handler — rather than asserting that a configuration value has the number 10
 * in it, which would prove nothing about behaviour.
 *
 * It runs in its own file because `resetModules` replaces the shared singletons.
 */

describe('rate limiting', () => {
	let server: Express;

	beforeAll(async () => {
		const knex = testDb();
		await resetApplicationTables(knex);
		await addUser(knex, {...EXECUTIVE_CREDENTIALS, role: 'EXECUTIVE'});

		// Rebuild the module graph so the limiter is constructed with a reachable limit.
		jest.resetModules();
		process.env.LOGIN_RATE_LIMIT_PER_MINUTE = '3';

		// `require` after `resetModules` is the point: a static `import` is hoisted and
		// would bind the ALREADY-constructed limiter, so the rebuilt module graph would
		// be ignored and this test would silently exercise the 1000-request limit.
		/* eslint-disable @typescript-eslint/no-require-imports */
		const express = require('express');
		const {createServer} = require('../../app');
		/* eslint-enable @typescript-eslint/no-require-imports */
		server = createServer(express());
	});

	afterAll(() => {
		process.env.LOGIN_RATE_LIMIT_PER_MINUTE = '1000';
		jest.resetModules();
	});

	it('returns 429 once the per-IP login limit is exceeded', async () => {
		const attempt = () =>
			supertest(server)
				.post('/api/v1/auth/login')
				.send({data: {email: EXECUTIVE_CREDENTIALS.email, password: 'deliberately-wrong'}});

		// Three attempts are within budget and must be refused on CREDENTIALS (401),
		// not on rate (429) — otherwise the test would pass for the wrong reason.
		for (let n = 0; n < 3; n++) {
			expect((await attempt()).status).toBe(401);
		}

		const throttled = await attempt();
		expect(throttled.status).toBe(429);
	});

	it('the 429 body carries no internal detail', async () => {
		const throttled = await supertest(server)
			.post('/api/v1/auth/login')
			.send({data: {email: EXECUTIVE_CREDENTIALS.email, password: 'deliberately-wrong'}});

		expect(throttled.status).toBe(429);
		const body = JSON.stringify(throttled.body);
		expect(body).not.toMatch(/users|password_hash|knex|stack/i);
	});
});
