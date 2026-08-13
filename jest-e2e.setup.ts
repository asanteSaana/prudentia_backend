import {config} from 'dotenv';
config({path: '.env.test'});

/**
 * Defaults so a fresh checkout runs without a `.env.test` (which is gitignored).
 *
 * LANDMINE, inherited from the template estate and worth repeating: this block is
 * guarded on DATABASE_HOST, so setting that ONE variable in CI skips the whole block —
 * taking AUTH_JWT_KEY and the read-only credentials with it. Any variable added here
 * must also be added to the CI workflow, or CI breaks in a way local runs never will.
 */
if (!process.env.DATABASE_HOST) {
	process.env.DATABASE_HOST = 'localhost';
	process.env.DATABASE_PORT = '5432';
	process.env.DATABASE_NAME = 'prudentia_test';
	process.env.DATABASE_USER = 'prudentia_app';
	process.env.DATABASE_PASSWORD = 'PrudenTiaApp#2026';
	process.env.DATABASE_RO_USER = 'prudentia_ro';
	process.env.DATABASE_RO_PASSWORD = 'PrudenTiaRo#2026';
}

// Set unconditionally, so they hold on CI too where DATABASE_HOST is supplied by the
// workflow and the block above is skipped.
process.env.AUTH_JWT_KEY = process.env.AUTH_JWT_KEY || 'test-jwt-key';
process.env.JWT_EXPIRY_MINUTES = process.env.JWT_EXPIRY_MINUTES || '60';
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'stub';
process.env.IS_PRODUCTION = 'false';

import {loadModule} from 'libpg-query';
import {Database} from './src/_services/databaseService';

jest.setTimeout(1000 * 120);

beforeAll(async () => {
	// The gate parses in-process, so the WASM parser must be loaded before any test
	// exercises it. In production this happens in initServer; the harness builds the app
	// with createServer and therefore has to do it here.
	await loadModule();

	// Do NOT swallow this. A migration failure would otherwise surface later as
	// confusing missing-column errors in unrelated tests.
	const knex = Database.getInstance();
	await knex.migrate.latest();

	/**
	 * Seed the analytics tables ONCE, if empty.
	 *
	 * The pipeline tests assert on real figures — a loss ratio inside insurance norms, a
	 * 12-row monthly series — so they need the dataset, not just the schema. Without it
	 * the queries run correctly and return NULL, which reads as a broken pipeline when it
	 * is actually a missing fixture.
	 *
	 * Guarded on emptiness rather than re-seeded per run: the analytics tables are
	 * read-only to every test, and rebuilding 67,000 rows for each suite would dominate
	 * the run time while proving nothing. `resetApplicationTables` clears users and
	 * query_log between suites; the analytics data is deliberately left alone.
	 */
	const [{count}] = (await knex.raw('SELECT COUNT(*)::int AS count FROM claims')).rows;
	if (count === 0) {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const {seed} = require('./src/_seeds/02_analytics_dataset');
		await seed(knex);
	}
});

afterAll(async () => {
	if (Database.KNEX_INSTANCE) {
		await Database.KNEX_INSTANCE.destroy();
	}
});
