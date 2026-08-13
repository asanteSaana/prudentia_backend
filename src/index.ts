import {config} from 'dotenv';
config();

import express from 'express';
import {loadModule} from 'libpg-query';
import {assertAuthConfigured, Database, validateReadOnlyPrivileges} from './_services';
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
	if (process.env.NODE_ENV !== 'production') console.log(`LLM provider: ${describeProvider()}`);

	const app = createServer(express());

	// Azure App Service supplies PORT. Reading it is not optional there.
	const port = process.env.PORT || 8080;
	app.listen(port, () => {
		if (process.env.NODE_ENV !== 'production') console.log(`PrudenTia API listening on ${port}`);
	});
}

if (require.main === module) {
	initServer().catch(error => {
		console.error('Startup failed:\n', error?.message ?? error);
		process.exit(1);
	});
}
