import type {Knex} from 'knex';
/**
 * ── This migration deliberately imports NOTHING from `_dbTables` (defect D-45) ──
 *
 * It used to loop over the live `ANALYTICS_TABLE_ORDER` constant. Adding `claim_payments`
 * to that constant therefore reached BACK IN TIME and changed what this already-written
 * migration does — and since the table is created by a later migration, a fresh database
 * failed here with `relation "public.claim_payments" does not exist`. It worked on every
 * existing database, because there the grant had come from the new migration; only a
 * from-scratch run could show it. CI, given a virgin database, showed it immediately.
 *
 * A migration is a historical record of one transition. Its behaviour must be fixed at
 * the moment it is written, so the lists below are frozen copies of the schema as it was
 * on 2026-08-12. A table added afterwards carries its own GRANT in its own migration —
 * which is exactly what `20260813120000_claim_payments.ts` does.
 */

/** The eight analytics tables that existed when this migration was written. */
const ANALYTICS_TABLES_AT_THIS_MIGRATION = [
	'regions',
	'customers',
	'vehicles',
	'policies',
	'premium_payments',
	'garages',
	'claims',
	'claim_assessments'
];

/** The application tables as at the same date. Never granted to the read-only role. */
const APPLICATION_TABLES_AT_THIS_MIGRATION = ['users', 'query_log'];

/**
 * Least-privilege role provisioning (ADR-03, NFR-02, FR-14).
 *
 * This is the second of the two independent controls in the defence-in-depth argument.
 * The validation gate is an application-level parser; this is a database-level
 * privilege. Both must fail for a write to land, and they fail for structurally
 * unrelated reasons — a bug in libpg-query is not correlated with a misconfigured
 * GRANT. That independence is the entire point.
 *
 * IDEMPOTENT by construction: it runs locally, then again against Azure where the role
 * may already exist (the prompt pack calls this out explicitly). Every statement is
 * CREATE-IF-ABSENT, ALTER, REVOKE or GRANT — all safely repeatable.
 *
 * Deliberately NOT used: `ALTER DEFAULT PRIVILEGES`. A future table must NOT become
 * readable automatically. Adding a table to the analytics schema should require an
 * explicit grant here *and* an entry in the schema catalogue — the friction is the
 * feature (ADR-02, TD-A), because silent divergence between what the model is told
 * exists and what the gate permits is the failure CLAUDE.md §4 rule 6 exists to stop.
 */

/**
 * Role names cannot be bound as parameters in DDL, so they are interpolated. The value
 * comes from `.env`, never from a request — but validating it anyway costs one line and
 * removes the question entirely.
 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertSafeIdentifier(value: string | undefined, label: string): string {
	if (!value || !SAFE_IDENTIFIER.test(value)) {
		throw new Error(
			`${label} must be a lowercase identifier matching ${SAFE_IDENTIFIER} — got ${JSON.stringify(value)}. ` +
				'Refusing to build a DDL statement from it.'
		);
	}
	return value;
}

/** Postgres string literal escaping: double any embedded single quote. */
function quoteLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export async function up(knex: Knex): Promise<void> {
	const role = assertSafeIdentifier(process.env.DATABASE_RO_USER, 'DATABASE_RO_USER');
	const password = process.env.DATABASE_RO_PASSWORD;
	const database = assertSafeIdentifier(process.env.DATABASE_NAME, 'DATABASE_NAME');
	const timeoutMs = parseInt(process.env.STATEMENT_TIMEOUT_MS ?? '10000', 10) || 10000;

	if (!password) {
		throw new Error('DATABASE_RO_PASSWORD is not set. The read-only role must have its own credential.');
	}

	// 1. The role. CREATE ROLE has no IF NOT EXISTS, so guard on the catalogue.
	//    NOSUPERUSER is not decoration: a superuser bypasses every GRANT below, which
	//    would make the whole of ADR-03 decorative and the Phase 7 defence-in-depth
	//    tests pass vacuously.
	await knex.raw(`
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN
				CREATE ROLE ${role} LOGIN PASSWORD ${quoteLiteral(password)}
					NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
			END IF;
		END
		$$;
	`);

	// Always reset the credential, so re-running repairs a drifted password.
	//
	// The attribute flags are deliberately NOT restated here. Only a superuser may set
	// the SUPERUSER attribute — even to NO — and the same holds for REPLICATION and
	// BYPASSRLS, so an ALTER carrying them fails for a CREATEROLE migration runner both
	// locally and on Azure (where the admin login is a member of azure_pg_admin but is
	// not a superuser). They are set once at CREATE, where they are also the defaults,
	// and then VERIFIED below rather than forced.
	await knex.raw(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)};`);

	// Verify the attributes really are what the security argument assumes. A role that
	// was hand-created as a superuser, or later granted BYPASSRLS, would satisfy every
	// GRANT below and still be able to write to anything — the privilege separation
	// would exist only on paper.
	const attributes = (
		await knex.raw(
			`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
			   FROM pg_roles WHERE rolname = ?`,
			[role]
		)
	).rows[0];

	const forbidden = (['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'] as const).filter(
		attribute => attributes?.[attribute] === true
	);

	if (forbidden.length > 0) {
		throw new Error(
			`Read-only role "${role}" holds forbidden attributes: ${forbidden.join(', ')}. ` +
				'A privileged role bypasses every GRANT below, so ADR-03 would hold only on paper. ' +
				`Fix as a superuser — ALTER ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; ` +
				'— then re-run the migrations.'
		);
	}

	if (attributes?.rolcanlogin !== true) {
		throw new Error(`Read-only role "${role}" cannot log in. The application could never use it.`);
	}

	// 2. Session defaults carried by the ROLE, so they hold even if the application
	//    forgets to set them — belt to the executor's braces.
	//    NFR-11: no executed statement runs longer than 10 seconds.
	await knex.raw(`ALTER ROLE ${role} SET default_transaction_read_only = on;`);
	await knex.raw(`ALTER ROLE ${role} SET statement_timeout = ${quoteLiteral(`${timeoutMs}ms`)};`);
	// Generated SQL is rejected before it reaches here if it names any schema other than
	// public (gate check 9), but pinning search_path means an unqualified name can never
	// resolve into pg_catalog or a schema added later.
	await knex.raw(`ALTER ROLE ${role} SET search_path = public;`);

	// 3. Connect and look, nothing more.
	await knex.raw(`GRANT CONNECT ON DATABASE ${database} TO ${role};`);
	await knex.raw(`GRANT USAGE ON SCHEMA public TO ${role};`);

	// 4. Start from nothing. If a previous run or a hand edit granted something wider,
	//    this is what takes it away — the grants below are then the complete set.
	await knex.raw(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role};`);
	await knex.raw(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role};`);
	await knex.raw(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role};`);
	await knex.raw(`REVOKE CREATE ON SCHEMA public FROM ${role};`);

	// 5. SELECT, one statement per table, exactly as specified. Enumerating them by hand
	//    rather than using ALL TABLES is the point: the grant list is reviewable, and a
	//    table added later is denied until someone adds a line here.
	for (const table of ANALYTICS_TABLES_AT_THIS_MIGRATION) {
		await knex.raw(`GRANT SELECT ON TABLE public.${table} TO ${role};`);
	}

	// 6. And explicitly nothing on the application tables. Redundant after the blanket
	//    REVOKE above — stated anyway, because this is the line that stops a total
	//    failure of the gate from reaching a password hash, and it should be impossible
	//    to miss when reading the migration.
	for (const table of APPLICATION_TABLES_AT_THIS_MIGRATION) {
		await knex.raw(`REVOKE ALL ON TABLE public.${table} FROM ${role};`);
	}

	// 7. Prove it took effect, here rather than only at boot. A migration that reports
	//    success while leaving the privilege separation unbuilt is worse than one that
	//    fails: the boot assertion would catch it, but the operator would already
	//    believe the database was provisioned.
	const [{count}] = (
		await knex.raw(
			`SELECT COUNT(*)::int AS count
			   FROM information_schema.role_table_grants
			  WHERE grantee = ? AND table_schema = 'public'`,
			[role]
		)
	).rows;

	if (count !== ANALYTICS_TABLES_AT_THIS_MIGRATION.length) {
		throw new Error(
			`Read-only role provisioning failed verification: expected ${ANALYTICS_TABLES_AT_THIS_MIGRATION.length} table grants ` +
				`for "${role}", found ${count}. Refusing to record this migration as applied.`
		);
	}
}

export async function down(knex: Knex): Promise<void> {
	const role = assertSafeIdentifier(process.env.DATABASE_RO_USER, 'DATABASE_RO_USER');
	const database = assertSafeIdentifier(process.env.DATABASE_NAME, 'DATABASE_NAME');

	// Privileges must be dropped before the role can be.
	await knex.raw(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role};`);
	await knex.raw(`REVOKE ALL ON SCHEMA public FROM ${role};`);
	await knex.raw(`REVOKE ALL ON DATABASE ${database} FROM ${role};`);
	await knex.raw(`
		DO $$
		BEGIN
			IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN
				DROP ROLE ${role};
			END IF;
		END
		$$;
	`);
}
