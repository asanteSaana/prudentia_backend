import {config} from 'dotenv';
config();

import express from 'express';
import {loadModule} from 'libpg-query';
import {assertAuthConfigured, assertSchemaWritable, Constants, Database, validateReadOnlyPrivileges} from './_services';
import {createServer} from './app';
import {describeProvider} from './llm';

/**
 * Boot order matters, and every step before `listen` is a refusal point.
 *
 * The template estate's precedent is to refuse to start on a misconfigured database
 * role rather than warn about it, and PrudenTia extends that to the two things its
 * security argument rests on: the read-only role really being read-only (ADR-03,
 * NFR-02) and the SQL parser really being loaded.
 *
 * A system whose defence in depth is known-broken should not accept traffic.
 */
export async function initServer(): Promise<void> {
	assertAuthConfigured();

	/**
	 * Before migrating, prove the role is allowed to. Since PostgreSQL 15 only the owner
	 * of schema `public` may create in it, and that ownership arrives implicitly via
	 * database ownership — so a deployment can create the role, set every environment
	 * variable correctly, and still fail at the first CREATE TABLE with a message that
	 * names no remedy (defect D-48).
	 */
	await assertSchemaWritable();

	// Fail loudly on a half-applied schema: the gate's whitelist and the catalogue the
	// LLM is shown both assume these tables exist (CLAUDE.md §4 rule 6).
	await Database.migrate();

	/**
	 * Load PostgreSQL's parser before serving. `parseSync` throws until `loadModule()`
	 * has been awaited — which fails CLOSED, so it is not a safety problem, but every
	 * question would be refused and it would look like a total outage rather than a
	 * missing await. Assert it here instead of discovering it per request.
	 */
	await loadModule();

	// NFR-02 / DV-9. Throws if a write succeeds, if the analytics tables are unreadable,
	// or if `users`/`query_log` are reachable.
	await validateReadOnlyPrivileges();

	/**
	 * Name the provider that is actually live.
	 *
	 * This is NOT a refusal point — a missing credential degrades to the stub rather than
	 * stopping the service, because nothing about the security boundary depends on which
	 * model answered (NFR-12). But it must be visible: a build quietly serving fixtures
	 * while the operator believes it is talking to Azure is the failure this line exists
	 * to prevent, and `getProvider()` has already logged a warning if it fell back.
	 */
	/**
	 * Logged in PRODUCTION too — only tests are silenced (defect D-47).
	 *
	 * These two lines were gated on `NODE_ENV !== 'production'`, so a deployed boot
	 * printed the read-only assertion and then went silent: no confirmation that the
	 * service began listening, and no way to tell from the log whether it had picked up
	 * its provider credentials. That is precisely the information a deployment needs, and
	 * precisely when it is hardest to get any other way.
	 *
	 * Neither line carries a secret. `describeProvider()` returns the provider's `name()`,
	 * which is vendor and model only — a test asserts it never contains a credential.
	 */
	if (!Constants.IS_TEST) console.log(`LLM provider: ${describeProvider()}`);

	const app = createServer(express());

	// Azure App Service supplies PORT. Reading it is not optional there.
	const port = process.env.PORT || 8080;
	app.listen(port, () => {
		if (!Constants.IS_TEST) console.log(`PrudenTia API listening on ${port}`);
	});
}

if (require.main === module) {
	initServer().catch(error => {
		console.error('Startup failed:\n', error?.message ?? error);
		process.exit(1);
	});
}
