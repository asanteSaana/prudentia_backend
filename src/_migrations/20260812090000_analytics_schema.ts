import type {Knex} from 'knex';
import {
	asCheck,
	Channels,
	ClaimCauses,
	ClaimStatuses,
	CustomerSegments,
	Genders,
	PaymentMethods,
	PolicyStatuses,
	ProductTypes,
	VehicleCategories,
	Zones
} from '../_typings/dbEnums';

/**
 * The 8 analytics tables (docs/02 §5.1). These are the ONLY tables the SELECT-only role
 * may read and the only ones the schema catalogue advertises to the LLM.
 *
 * Three rules hold throughout:
 *
 *  - **snake_case columns** (CLAUDE.md §5, DV-0). The LLM reads these identifiers, and a
 *    camelCase column in PostgreSQL must be double-quoted in every generated statement —
 *    a needless failure mode for an untrusted generator.
 *
 *  - **Money is numeric(12,2), never float** (CLAUDE.md §6). Loss ratio is the single
 *    most important figure in the system; binary floating point would make it
 *    irreproducible at the last decimal and the test suite asserts exact values.
 *
 *  - **No personally identifying attributes on `customers`** (ADR-09, FR-28, TH-09).
 *    No name, address, phone or national ID. `customer_ref` is an opaque surrogate.
 *    Absence beats filtering: a filter can be bypassed, a column that does not exist
 *    cannot be selected.
 *
 * Indexes are placed on foreign keys and on the columns the acceptance corpus filters
 * and groups by — the date columns on `claims` and `policies` especially, since every
 * temporal question in the corpus touches them.
 */
export async function up(knex: Knex): Promise<void> {
	await knex.schema.createTable('regions', table => {
		table.increments('id').primary();
		table.string('name', 100).notNullable().unique();
		// Denormalised so a geographic rollup needs no self-referencing hierarchy for
		// the model to navigate (docs §5.3).
		table.string('zone', 20).notNullable().checkIn(asCheck(Zones));
		table.index('zone', 'idx_regions_zone');
	});

	await knex.schema.createTable('customers', table => {
		table.increments('id').primary();
		// ADR-09: an opaque surrogate. Deliberately NOT derived from anything personal.
		table.string('customer_ref', 20).notNullable().unique();
		table.integer('region_id').notNullable().references('id').inTable('regions');
		// Year only, never a date of birth — enough for age-band analysis, not enough to
		// identify anyone.
		table.integer('birth_year').notNullable();
		table.string('gender', 10).notNullable().checkIn(asCheck(Genders));
		table.date('joined_at').notNullable();
		table.string('segment', 20).notNullable().checkIn(asCheck(CustomerSegments));
		table.index('region_id', 'idx_customers_region_id');
		table.index('segment', 'idx_customers_segment');
	});

	await knex.schema.createTable('vehicles', table => {
		table.increments('id').primary();
		table.integer('customer_id').notNullable().references('id').inTable('customers');
		table.string('make', 50).notNullable();
		table.string('model', 50).notNullable();
		table.integer('year_of_manufacture').notNullable();
		table.string('category', 20).notNullable().checkIn(asCheck(VehicleCategories));
		table.integer('engine_capacity_cc').notNullable();
		table.decimal('value_ghs', 12, 2).notNullable();
		table.index('customer_id', 'idx_vehicles_customer_id');
		table.index('category', 'idx_vehicles_category');
	});

	await knex.schema.createTable('policies', table => {
		table.increments('id').primary();
		table.string('policy_number', 30).notNullable().unique();
		table.integer('customer_id').notNullable().references('id').inTable('customers');
		table.integer('vehicle_id').notNullable().references('id').inTable('vehicles');
		table.string('product_type', 30).notNullable().checkIn(asCheck(ProductTypes));
		table.string('channel', 20).notNullable().checkIn(asCheck(Channels));
		table.date('start_date').notNullable();
		table.date('end_date').notNullable();
		table.decimal('written_premium', 12, 2).notNullable();
		/**
		 * Stored, not computed (docs §5.3, debt TD-B).
		 *
		 * Earned premium needs pro-rata date arithmetic that LLMs reliably get wrong, and
		 * it is the denominator of the loss ratio — the figure the whole product exists to
		 * report. Pre-computing it trades normalisation for correctness deliberately. The
		 * cost is that a stored derived value can drift if a policy is ever amended, which
		 * is exactly what TD-B records.
		 */
		table.decimal('earned_premium', 12, 2).notNullable();
		table.string('status', 20).notNullable().checkIn(asCheck(PolicyStatuses));
		table.index('customer_id', 'idx_policies_customer_id');
		table.index('vehicle_id', 'idx_policies_vehicle_id');
		table.index('status', 'idx_policies_status');
		table.index('channel', 'idx_policies_channel');
		table.index('product_type', 'idx_policies_product_type');
		table.index('start_date', 'idx_policies_start_date');
	});

	await knex.schema.createTable('premium_payments', table => {
		table.increments('id').primary();
		table.integer('policy_id').notNullable().references('id').inTable('policies');
		table.date('payment_date').notNullable();
		table.decimal('amount', 12, 2).notNullable();
		table.string('method', 20).notNullable().checkIn(asCheck(PaymentMethods));
		table.index('policy_id', 'idx_premium_payments_policy_id');
		table.index('payment_date', 'idx_premium_payments_payment_date');
	});

	await knex.schema.createTable('garages', table => {
		table.increments('id').primary();
		table.string('name', 120).notNullable();
		table.integer('region_id').notNullable().references('id').inTable('regions');
		table.boolean('is_approved').notNullable();
		table.decimal('rating', 3, 2).notNullable();
		table.index('region_id', 'idx_garages_region_id');
		table.index('is_approved', 'idx_garages_is_approved');
	});

	await knex.schema.createTable('claims', table => {
		table.increments('id').primary();
		table.string('claim_number', 30).notNullable().unique();
		table.integer('policy_id').notNullable().references('id').inTable('policies');
		table.date('incident_date').notNullable();
		table.date('notification_date').notNullable();
		// Null until settled. Settlement cycle time is defined over settled claims only
		// (docs §5.3 glossary), so this being nullable is what makes that definition
		// expressible rather than approximated.
		table.date('settlement_date').nullable();
		table.string('cause', 20).notNullable().checkIn(asCheck(ClaimCauses));
		table.string('status', 20).notNullable().checkIn(asCheck(ClaimStatuses));
		/**
		 * incurred drives the loss ratio; paid drives cash flow (docs §5.3). Held
		 * separately so the metric glossary can be precise about which one a question
		 * means — conflating them is the most common way to get a loss ratio subtly wrong.
		 */
		table.decimal('incurred_amount', 12, 2).notNullable();
		table.decimal('paid_amount', 12, 2).notNullable();
		table.boolean('fraud_flag').notNullable().defaultTo(false);
		table.index('policy_id', 'idx_claims_policy_id');
		table.index('incident_date', 'idx_claims_incident_date');
		table.index('notification_date', 'idx_claims_notification_date');
		table.index('status', 'idx_claims_status');
		table.index('cause', 'idx_claims_cause');
		table.index('fraud_flag', 'idx_claims_fraud_flag');
	});

	await knex.schema.createTable('claim_assessments', table => {
		table.increments('id').primary();
		table.integer('claim_id').notNullable().references('id').inTable('claims');
		table.integer('garage_id').notNullable().references('id').inTable('garages');
		table.date('assessment_date').notNullable();
		table.decimal('assessed_amount', 12, 2).notNullable();
		table.decimal('approved_amount', 12, 2).notNullable();
		table.decimal('labour_hours', 6, 2).notNullable();
		table.index('claim_id', 'idx_claim_assessments_claim_id');
		table.index('garage_id', 'idx_claim_assessments_garage_id');
	});
}

export async function down(knex: Knex): Promise<void> {
	// Reverse dependency order.
	await knex.schema.dropTableIfExists('claim_assessments');
	await knex.schema.dropTableIfExists('claims');
	await knex.schema.dropTableIfExists('garages');
	await knex.schema.dropTableIfExists('premium_payments');
	await knex.schema.dropTableIfExists('policies');
	await knex.schema.dropTableIfExists('vehicles');
	await knex.schema.dropTableIfExists('customers');
	await knex.schema.dropTableIfExists('regions');
}
