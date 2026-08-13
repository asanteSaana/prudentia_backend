import express, {Express} from 'express';
import {Knex} from 'knex';
import {Database} from '../_services/databaseService';
import {createServer} from '../app';

/**
 * Integration-test harness.
 *
 * `createServer` is called directly rather than `initServer`, so the suite does NOT run
 * the boot assertions. That is a deliberate trade with a real cost, and it is worth
 * naming: the read-only privilege assertion (NFR-02) is therefore not exercised here,
 * and the Phase 7 defence-in-depth suite tests it explicitly instead. A harness that
 * booted the whole application would couple every endpoint test to database
 * provisioning.
 */
export function startTestServer(): Express {
	return createServer(express());
}

export function testDb(): Knex {
	return Database.getInstance();
}

/**
 * Reset the application tables between suites.
 *
 * `query_log` first: it has a foreign key to `users`, and although it is ON DELETE SET
 * NULL rather than CASCADE, clearing it first keeps the intent obvious.
 *
 * The ANALYTICS tables are deliberately NOT reset — they are seeded once and are read
 * only. Rebuilding 67,000 rows per suite would dominate the run time and prove nothing.
 */
export async function resetApplicationTables(knex: Knex): Promise<void> {
	await knex('query_log').del();
	await knex('users').del();
}
