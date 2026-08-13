import {Knex} from 'knex';
import {AnalyticsTables, APPLICATION_TABLE_LIST} from './_dbTables';
import {Database, ReadOnlyDatabase} from './databaseService';

/**
 * Boot-time proof that the second line of defence is actually there (NFR-02, ADR-03).
 *
 * ADR-03's argument is that two independent controls — the validation gate and the
 * database role — must BOTH fail for a write to land. That argument is only worth
 * anything if the role is really restricted. A misconfigured environment, a migration
 * that did not run, or a `.env` pointing the read-only connection at the read-write
 * role would leave the system running on one control while appearing to run on two.
 *
 * The prompt pack asks this to "log CRITICAL if it succeeds". It THROWS instead
 * (deviation DV-9), following the template estate's precedent of refusing to boot on a
 * misconfigured database role. A log line in a system nobody is watching is not a
 * control, and a system whose defence in depth is known-broken should not accept
 * traffic.
 *
 * Three assertions:
 *   1. a write through the read-only connection must be refused
 *   2. a read of a whitelisted analytics table must succeed
 *   3. a read of `users` must be refused — even a total gate failure cannot reach a
 *      password hash (CLAUDE.md §4 rule 5)
 */
export async function validateReadOnlyPrivileges(): Promise<void> {
	const readonly = ReadOnlyDatabase.getInstance();

	await assertWriteIsRefused(readonly);
	await assertAnalyticsReadSucceeds(readonly);
	await assertApplicationTablesAreUnreachable(readonly);

	console.log(
		`Read-only role verified: writes refused, ${Object.keys(AnalyticsTables).length} analytics tables readable, ` +
			`${APPLICATION_TABLE_LIST.join(' and ')} unreachable.`
	);
}

async function assertWriteIsRefused(readonly: Knex): Promise<void> {
	let succeeded = false;

	try {
		await readonly.transaction(async trx => {
			/**
			 * Make THIS transaction read-write before attempting the write.
			 *
			 * This line is the difference between a real assertion and a vacuous one.
			 * The pool sets `default_transaction_read_only = on` in `afterCreate` and the
			 * role carries the same default, so without lifting it the DELETE is refused
			 * by SESSION CONFIGURATION rather than by PRIVILEGE — the check would pass
			 * against a superuser and prove nothing about the grant it exists to verify.
			 *
			 * It must be `SET TRANSACTION READ WRITE`, not
			 * `SET LOCAL default_transaction_read_only = off`. The latter changes the
			 * DEFAULT for subsequent transactions; the current one had its read-only
			 * state fixed at BEGIN and is unaffected. That first attempt looked correct,
			 * ran without error, and left the assertion exactly as vacuous as before —
			 * which is why the probe is now exercised from both directions in the tests
			 * rather than trusted because it is written down.
			 *
			 * The transaction is rolled back regardless of outcome.
			 */
			await trx.raw('SET TRANSACTION READ WRITE');

			// Harmless by construction: a DELETE whose predicate matches no row. What is
			// under test is whether the statement is permitted, not what it would do.
			await trx.raw('DELETE FROM claims WHERE 1 = 0');
			succeeded = true;

			// Never commit, even though nothing was changed.
			throw new ReadOnlyProbeRollback();
		});
	} catch (error) {
		if (!(error instanceof ReadOnlyProbeRollback) && !succeeded) {
			return; // refused on privilege, as required
		}
	}

	if (succeeded) {
		throw new Error(
			'CRITICAL: a write succeeded through the read-only connection with the read-only ' +
				'transaction flag disabled. DATABASE_RO_USER holds write privilege, or the privilege ' +
				'migration has not run. Refusing to start — defence in depth (ADR-03/NFR-02) is not in place.'
		);
	}
}

/** Sentinel used to roll the privilege probe back without reporting it as a failure. */
class ReadOnlyProbeRollback extends Error {}

async function assertAnalyticsReadSucceeds(readonly: Knex): Promise<void> {
	try {
		await readonly.raw('SELECT 1 FROM claims LIMIT 1');
	} catch (error: any) {
		throw new Error(
			`CRITICAL: the read-only role cannot read the analytics tables (${error?.code ?? 'unknown'}). ` +
				'Every question would be refused for the wrong reason. Refusing to start.'
		);
	}
}

async function assertApplicationTablesAreUnreachable(readonly: Knex): Promise<void> {
	for (const table of APPLICATION_TABLE_LIST) {
		let reachable = false;
		try {
			// Table name comes from a hard-coded constant list, never from user input.
			await readonly.raw(`SELECT 1 FROM ${table} LIMIT 1`);
			reachable = true;
		} catch {
			// denied, as required
		}

		if (reachable) {
			throw new Error(
				`CRITICAL: the read-only role can read "${table}". ` +
					'A failure of the validation gate would expose password hashes or the audit trail. ' +
					'Refusing to start — revoke the privilege and re-run the migrations.'
			);
		}
	}
}

/**
 * Refuse to start if the application role cannot create objects in `public`.
 *
 * ── Why this is worth a boot check of its own (defect D-48) ─────────────────
 *
 * PostgreSQL 15 stopped granting `CREATE` on `public` to `PUBLIC`. Only the schema's
 * owner may create there — and `public` is owned by the special role
 * `pg_database_owner`, of which the **database owner** is implicitly a member. So the
 * application role gets `CREATE` by owning the database, not by any explicit grant, and
 * a deployment that creates the role but never transfers database ownership looks
 * perfectly configured and fails at the first migration.
 *
 * Knex's own error — `create table "knex_migrations" … permission denied for schema
 * public` — is accurate and tells an operator nothing about what to do. This runs before
 * the migration and names the remedy, because the difference between those two messages
 * is the difference between a minute and an afternoon.
 */
export async function assertSchemaWritable(): Promise<void> {
	const knex = Database.getInstance();

	const [state] = (
		await knex.raw(`
			SELECT current_user                                            AS role,
			       current_database()                                      AS database,
			       has_schema_privilege(current_user, 'public', 'CREATE')   AS can_create,
			       pg_get_userbyid(d.datdba)                                AS database_owner,
			       pg_get_userbyid(n.nspowner)                              AS schema_owner
			  FROM pg_database d, pg_namespace n
			 WHERE d.datname = current_database() AND n.nspname = 'public'
		`)
	).rows;

	if (state?.can_create) return;

	throw new Error(
		`Role "${state?.role}" cannot CREATE in schema public of database "${state?.database}", ` +
			'so migrations cannot run.\n' +
			`  schema public is owned by : ${state?.schema_owner}\n` +
			`  the database is owned by  : ${state?.database_owner}\n` +
			'Since PostgreSQL 15, only the owner of schema public may create objects in it, and the\n' +
			'database owner is a member of pg_database_owner implicitly. Fix as the admin login:\n\n' +
			`  ALTER DATABASE ${state?.database} OWNER TO ${state?.role};\n` +
			`  ALTER SCHEMA public OWNER TO ${state?.role};   -- only if schema_owner above is not pg_database_owner\n`
	);
}
