import type {Knex} from 'knex';
import {AnalyticsTables} from '../_services/_dbTables';
import {asCheck, ClaimPaymentTypes} from '../_typings/dbEnums';

/**
 * `claim_payments` — when each portion of a claim was actually paid.
 *
 * ── Why this table exists ────────────────────────────────────────────────────
 *
 * A loss development triangle needs payment TRANSACTIONS dated over time. Until now the
 * schema recorded only `claims.paid_amount`, a single cumulative figure with no dates, so
 * "cumulative paid by development year" was not computable from it — and a generated
 * query that appeared to compute one had to be using the wrong data. Exactly that
 * happened: a triangle was assembled from `premium_payments`, which is money coming IN
 * from policyholders (defect D-42). It passed every gate check and was entirely wrong.
 *
 * Adding the table is the only real fix. The catalogue wording that now warns the model
 * off `premium_payments` reduces the chance of the mistake; this removes the reason for
 * it, by making the honest answer available.
 *
 * ── The grant is the part that matters ───────────────────────────────────────
 *
 * Creating the table does NOT expose it. Three things must all happen, and they are
 * deliberately separate (CLAUDE.md §4 rules 5 and 6):
 *
 *   1. the table exists                        — here
 *   2. the read-only role holds SELECT on it   — here, one explicit statement
 *   3. the catalogue describes it              — src/guard/catalogue.ts
 *
 * Miss (2) and every generated query touching it fails at execution with a permission
 * error the user cannot act on. Miss (3) and the gate refuses it as not whitelisted, even
 * though it exists and is readable. The separation is what makes "is this table exposed
 * to generated SQL?" answerable by reading one line in each place rather than inferring
 * it from the absence of something.
 */

const TABLE = AnalyticsTables.ClaimPayments;

export async function up(knex: Knex): Promise<void> {
	await knex.schema.createTable(TABLE, table => {
		table.increments('id').primary();

		table
			.integer('claim_id')
			.notNullable()
			.references('id')
			.inTable(AnalyticsTables.Claims)
			// A payment cannot outlive the claim it belongs to.
			.onDelete('CASCADE');

		table.date('payment_date').notNullable();
		table.decimal('amount', 14, 2).notNullable();
		table.string('payment_type', 10).notNullable().checkIn(asCheck(ClaimPaymentTypes));

		/**
		 * The index the triangle actually uses. Every development query groups by claim
		 * and orders by date, and the table is the largest in the analytics schema after
		 * `premium_payments` — without this, a triangle is a sequential scan under a
		 * 10-second statement timeout.
		 */
		table.index(['claim_id', 'payment_date'], 'claim_payments_claim_date_idx');
		// Accident-year/development-year bucketing filters on date alone.
		table.index(['payment_date'], 'claim_payments_date_idx');
	});

	/**
	 * SELECT, and only SELECT, to the read-only role — written by hand, one statement,
	 * exactly as the other eight were. Deliberately not a loop over the table list: a
	 * loop would silently grant on any table added later, which is the opposite of the
	 * property this design wants.
	 *
	 * The role name comes from the environment because it differs between the local
	 * database and the deployed one; it is an identifier, so it cannot be a bind
	 * parameter, and it is operator-supplied configuration rather than user input.
	 */
	const role = process.env.DATABASE_RO_USER;
	if (!role) {
		throw new Error(
			'DATABASE_RO_USER is not set. The read-only role must be named before claim_payments can be granted to it — ' +
				'creating the table without the grant would expose a table the gate permits but the executor cannot read.'
		);
	}

	await knex.raw(`GRANT SELECT ON TABLE public.${TABLE} TO ${role};`);

	// Prove it took, here rather than only at boot. A migration that reports success
	// while leaving the grant unmade is worse than one that fails.
	const [{count}] = (
		await knex.raw(
			`SELECT COUNT(*)::int AS count
			   FROM information_schema.role_table_grants
			  WHERE grantee = ? AND table_schema = 'public' AND table_name = ? AND privilege_type = 'SELECT'`,
			[role, TABLE]
		)
	).rows;

	if (count !== 1) {
		throw new Error(`GRANT SELECT on ${TABLE} to ${role} did not take effect; found ${count} matching grants.`);
	}
}

export async function down(knex: Knex): Promise<void> {
	// Dropping the table drops its grants with it.
	await knex.schema.dropTableIfExists(TABLE);
}
