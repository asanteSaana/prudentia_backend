import knex, {Knex} from 'knex';
import path from 'path';
import {Constants} from './_constants';
import {getBaseDir} from './utilities';

/**
 * TWO connections, always (CLAUDE.md §4 rule 4, ADR-03, NFR-02).
 *
 * They are exported as two separately-named namespaces rather than as one factory
 * taking a flag, because the whole point is that a mistake should be visible at the
 * import site. `import {ReadOnlyDatabase}` in a file that has no business executing
 * generated SQL is caught by the `no-generated-sql-outside-guard` lint rule; a
 * `getInstance({readonly: true})` call would not be.
 *
 *   Database          read-write   migrations, seeds, auth, audit log
 *   ReadOnlyDatabase  SELECT only  validated generated SQL, and NOTHING else
 *
 * They are never interchangeable.
 */

const MIN_POOL_CONNECTIONS = 0;
const MAX_POOL_CONNECTIONS = 70;

/**
 * The read-only pool is deliberately much smaller. Generated analytical SQL can be
 * expensive by nature, and a burst of it must not be able to starve authentication and
 * audit writes of connections — the audit write on the failure path is precisely the
 * record that matters (ADR-07), so it must not be the thing that gets squeezed out.
 */
const MAX_READONLY_POOL_CONNECTIONS = 8;

/**
 * Where the migrations are, and in what form.
 *
 * ── The directory needs NO environment branch (defect D-46) ──────────────────
 *
 * `getBaseDir()` is already `src/` under ts-node-dev and jest, and `dist/` after a build —
 * it resolves from `__dirname`, which moves with the compiled output. Appending a literal
 * `'dist'` on top of that double-counted it, and because the branch contributed an empty
 * segment in dev and test, **the wrong half only ever ran in production**:
 *
 *   dev   <root>/src  + ''     + _migrations  ->  <root>/src/_migrations          ✔
 *   prod  <root>/dist + 'dist' + _migrations  ->  <root>/dist/dist/_migrations    ✘
 *
 * The deployed service failed at boot with `ENOENT … scandir '/home/site/wwwroot/dist/
 * dist/_migrations'`, having passed every test — none of which run in production mode.
 *
 * The EXTENSION branch is real and stays: ts-node-dev and ts-jest load `.ts`, the built
 * output is `.js`.
 */
const migrationDir: Knex.MigratorConfig = {
	directory: path.join(getBaseDir(), '_migrations'),
	extension: Constants.IS_DEV || Constants.IS_TEST ? 'ts' : 'js'
};

const sslConfig = Constants.IS_PRODUCTION || Constants.SSL_MODE ? {rejectUnauthorized: false} : false;

export namespace Database {
	export let KNEX_INSTANCE: Knex;

	const connectionParams: Knex.StaticConnectionConfig = {
		host: Constants.DB_CONNECTION.host,
		database: Constants.DB_CONNECTION.database,
		user: Constants.DB_CONNECTION.user,
		port: Constants.DB_CONNECTION.port,
		password: Constants.DB_CONNECTION.password,
		ssl: sslConfig
	};

	export const getInstance = () => {
		if (!KNEX_INSTANCE) {
			KNEX_INSTANCE = knex({
				client: 'pg',
				connection: connectionParams,
				migrations: migrationDir,
				pool: {
					min: MIN_POOL_CONNECTIONS,
					max: MAX_POOL_CONNECTIONS,
					idleTimeoutMillis: 30000,
					createTimeoutMillis: 180000,
					acquireTimeoutMillis: 180000
				}
			});
		}
		return KNEX_INSTANCE;
	};

	/**
	 * Runs pending migrations.
	 *
	 * The template swallows migration failures so the server still starts. PrudenTia
	 * does NOT (deviation C-8): the schema catalogue is the single source of truth for
	 * both what the LLM is told exists and what the gate permits, so a half-applied
	 * migration means the catalogue advertises tables that may not be there. That is
	 * silent divergence between the model's map and the territory — exactly what
	 * CLAUDE.md §4 rule 6 exists to prevent. Fail loudly instead.
	 */
	export const migrate = async () => {
		await getInstance().migrate.latest();
	};

	/** Separate pool for the test harness, connecting without a target database. */
	export const getDBTestInstance = () =>
		knex({
			client: 'pg',
			connection: {
				host: Constants.DB_CONNECTION.host,
				user: Constants.DB_CONNECTION.user,
				port: Constants.DB_CONNECTION.port,
				password: Constants.DB_CONNECTION.password,
				ssl: sslConfig
			},
			migrations: migrationDir,
			pool: {min: MIN_POOL_CONNECTIONS, max: MAX_POOL_CONNECTIONS}
		});
}

export namespace ReadOnlyDatabase {
	export let KNEX_INSTANCE: Knex;

	const connectionParams: Knex.StaticConnectionConfig = {
		host: Constants.DB_READONLY_CONNECTION.host,
		database: Constants.DB_READONLY_CONNECTION.database,
		user: Constants.DB_READONLY_CONNECTION.user,
		port: Constants.DB_READONLY_CONNECTION.port,
		password: Constants.DB_READONLY_CONNECTION.password,
		ssl: sslConfig
	};

	export const getInstance = () => {
		if (!KNEX_INSTANCE) {
			KNEX_INSTANCE = knex({
				client: 'pg',
				connection: connectionParams,
				pool: {
					min: MIN_POOL_CONNECTIONS,
					max: MAX_READONLY_POOL_CONNECTIONS,
					idleTimeoutMillis: 30000,
					createTimeoutMillis: 30000,
					acquireTimeoutMillis: 30000,

					/**
					 * Belt and braces on NFR-11. The statement timeout is set on the ROLE
					 * in a migration, so it holds even if the application forgets to ask;
					 * setting it again per connection means a role that was provisioned by
					 * hand, or altered later, still cannot run away.
					 */
					afterCreate: (connection: any, done: (err?: Error) => void) => {
						connection.query(
							`SET statement_timeout = ${Constants.STATEMENT_TIMEOUT_MS}; SET default_transaction_read_only = on;`,
							(err: Error) => done(err)
						);
					}
				}
			});
		}
		return KNEX_INSTANCE;
	};
}
