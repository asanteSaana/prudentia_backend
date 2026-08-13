import {config} from 'dotenv';
config();

/**
 * Knex CLI configuration. Single unnamed config, switched by environment variables —
 * matching the template convention (no development/production keys).
 *
 * This is the READ-WRITE connection: migrations, seeds, auth and the audit log.
 * The SELECT-only connection used for generated SQL is built separately in
 * src/_services/databaseService.ts and is deliberately NOT reachable from the CLI.
 *
 * CLAUDE.md §4 rule 4 — two connections, always, never interchangeable.
 */
export default {
	client: 'pg',
	connection: {
		host: process.env.DATABASE_HOST,
		port: parseInt(process.env.DATABASE_PORT ?? '5432'),
		user: process.env.DATABASE_USER,
		password: process.env.DATABASE_PASSWORD,
		database: process.env.DATABASE_NAME,
		...(process.env.SSL_MODE_ENV === 'true'
			? {
					ssl: {
						rejectUnauthorized: false
					}
				}
			: {ssl: false})
	},
	migrations: {
		directory: './src/_migrations',
		extension: 'ts'
	},
	seeds: {
		directory: './src/_seeds'
	}
};

/**
 * knex migrate:make <name>     -> new file in src/_migrations
 * knex migrate:latest          -> apply
 * knex migrate:rollback        -> undo the last batch
 * knex seed:run                -> run src/_seeds in filename order
 */
