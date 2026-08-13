import type {Knex} from 'knex';
import {asCheck, ChartTypes, ExecutionStatuses, UserRoles, ValidationStatuses} from '../_typings/dbEnums';

/**
 * The application tables (docs/02 §5.2). These are NEVER exposed to generated SQL.
 *
 * They are absent from the schema catalogue, so the gate rejects any statement
 * referencing them at the table check — regardless of whether the model was persuaded
 * to try (TH-02). And they are absent from the read-only role's grants, so even a total
 * failure of the gate cannot read a password hash (CLAUDE.md §4 rule 5).
 *
 * Two independent controls, failing for structurally different reasons. That
 * independence is the point of ADR-03: a bug in the parser is not correlated with a
 * misconfiguration of a database role.
 */
export async function up(knex: Knex): Promise<void> {
	await knex.schema.createTable('users', table => {
		table.increments('id').primary();
		table.string('email', 255).notNullable().unique();
		// scrypt, stored as `${salt}.${hash}` — 32 hex salt + '.' + 128 hex key = 161.
		// Sized generously in case the work factor or key length is ever raised.
		table.string('password_hash', 255).notNullable();
		table.string('full_name', 120).notNullable();
		// FR-04: exactly one role per account.
		table.string('role', 20).notNullable().checkIn(asCheck(UserRoles));
		table.boolean('is_active').notNullable().defaultTo(true);
		table.timestamp('created_at', {useTz: true}).notNullable().defaultTo(knex.fn.now());
		table.index('email', 'idx_users_email');
	});

	await knex.schema.createTable('query_log', table => {
		table.increments('id').primary();
		/**
		 * Nullable on purpose. The audit record must survive the user being deleted —
		 * NFR-15 requires every attempt to remain reconstructible, and a cascade would
		 * quietly erase exactly the history an investigator needs. ON DELETE SET NULL
		 * keeps the record and loses only the attribution.
		 */
		table.integer('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
		table.text('question').notNullable();
		// Null when the provider failed before proposing anything.
		table.text('generated_sql').nullable();
		table.string('validation_status', 20).notNullable().checkIn(asCheck(ValidationStatuses));
		/**
		 * The full reason and the specific check that failed. This is the ONLY place
		 * either is written (CLAUDE.md §4 rule 7): the user receives one fixed generic
		 * sentence, because a specific message is an oracle for probing the gate.
		 *
		 * These two columns are also the triage taxonomy — `failed_check =
		 * unknown_column` means schema drift or a model regression, `execution_status =
		 * TIMEOUT` means query complexity. Built into the data model rather than
		 * reconstructed from log text later.
		 */
		table.text('rejection_reason').nullable();
		table.string('failed_check', 50).nullable();
		table.string('execution_status', 30).notNullable().checkIn(asCheck(ExecutionStatuses));
		table.integer('row_count').nullable();
		table.integer('duration_ms').nullable();
		table.string('chart_type', 10).nullable().checkIn(asCheck(ChartTypes));
		table.timestamp('created_at', {useTz: true}).notNullable().defaultTo(knex.fn.now());

		table.index('user_id', 'idx_query_log_user_id');
		table.index('created_at', 'idx_query_log_created_at');
		// The rejection-rate trend is the primary health signal (docs/04 §3.1): a rise
		// means either an attack or a generation regression. Indexed so that query is
		// cheap enough to run routinely.
		table.index('validation_status', 'idx_query_log_validation_status');
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.dropTableIfExists('query_log');
	await knex.schema.dropTableIfExists('users');
}
