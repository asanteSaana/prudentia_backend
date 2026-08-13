/**
 * The schema catalogue — ONE source, TWO consumers (CLAUDE.md §4 rule 6).
 *
 *   1. `renderSchemaForLlm()` builds the schema description the model is shown.
 *   2. `ALLOWED_TABLES` / `ALLOWED_COLUMNS` are what the validation gate permits.
 *
 * They must not be able to diverge. If the model were told a table exists that the gate
 * refuses, every question about it would be rejected for a reason the user cannot see
 * and the model cannot learn from — the worst possible failure, because it looks like
 * the system is broken rather than that the question is out of scope. The reverse is
 * worse still: a table the gate permits but the model is never told about is an
 * unreviewed hole in the whitelist.
 *
 * `__tests__/catalogue.test.ts` asserts the two cannot drift.
 *
 * ADDING A TABLE requires three coordinated edits — here, a `GRANT SELECT` in a
 * migration, and the entry in `_dbTables.ts`. That friction is deliberate (ADR-02,
 * TD-A): fail closed, and make widening the boundary a visible act.
 */

export interface CatalogueColumn {
	name: string;
	type: string;
	description: string;
}

export interface CatalogueTable {
	name: string;
	description: string;
	columns: CatalogueColumn[];
}

/**
 * The 8 analytics tables. `users` and `query_log` are deliberately ABSENT — that
 * absence is what makes TH-02 (prompt injection reaching for credentials) fail at the
 * table check regardless of whether the model was persuaded to try.
 */
export const CATALOGUE: CatalogueTable[] = [
	{
		name: 'regions',
		description: 'Ghanaian administrative regions. Reached from a claim only through policies → customers.',
		columns: [
			{name: 'id', type: 'integer', description: 'Primary key'},
			{name: 'name', type: 'text', description: 'Region name, e.g. Greater Accra'},
			{name: 'zone', type: 'text', description: 'NORTHERN | MIDDLE | COASTAL'}
		]
	},
	{
		name: 'customers',
		description:
			'Policyholders. Contains NO personal identifying data by design — no name, address, phone or national ID. customer_ref is an opaque surrogate.',
		columns: [
			{name: 'id', type: 'integer', description: 'Primary key'},
			// No format example here, deliberately. ADR-06 sends structure, never
			// contents, and an illustrative value is the thin end of that wedge — the
			// catalogue test asserts nothing data-shaped reaches the provider.
			{name: 'customer_ref', type: 'text', description: 'Opaque surrogate reference. Carries no personal meaning.'},
			{name: 'region_id', type: 'integer', description: 'FK to regions.id'},
			{name: 'birth_year', type: 'integer', description: 'Year of birth only'},
			{name: 'gender', type: 'text', description: 'MALE | FEMALE'},
			{name: 'joined_at', type: 'date', description: 'Date the customer joined'},
			{name: 'segment', type: 'text', description: 'RETAIL | SME | CORPORATE | FLEET'}
		]
	},
	{
		name: 'vehicles',
		description: 'Insured vehicles, one owner each.',
		columns: [
			{name: 'id', type: 'integer', description: 'Primary key'},
			{name: 'customer_id', type: 'integer', description: 'FK to customers.id'},
			{name: 'make', type: 'text', description: 'Manufacturer'},
			{name: 'model', type: 'text', description: 'Model name'},
			{name: 'year_of_manufacture', type: 'integer', description: 'Year built'},
			{name: 'category', type: 'text', description: 'SEDAN | SUV | PICKUP | MOTORCYCLE | BUS | TRUCK'},
			{name: 'engine_capacity_cc', type: 'integer', description: 'Engine size in cc'},
			{name: 'value_ghs', type: 'numeric', description: 'Insured value in GHS'}
		]
	},
	{
		name: 'policies',
		description: 'Motor policies. One customer and one vehicle each; annual cover.',
		columns: [
			{name: 'id', type: 'integer', description: 'Primary key'},
			{name: 'policy_number', type: 'text', description: 'Policy reference'},
			{name: 'customer_id', type: 'integer', description: 'FK to customers.id'},
			{name: 'vehicle_id', type: 'integer', description: 'FK to vehicles.id'},
			{name: 'product_type', type: 'text', description: 'COMPREHENSIVE | THIRD_PARTY | THIRD_PARTY_FIRE_THEFT'},
			{name: 'channel', type: 'text', description: 'DIRECT | BROKER | AGENT | BANCASSURANCE'},
			{name: 'start_date', type: 'date', description: 'Cover start'},
			{name: 'end_date', type: 'date', description: 'Cover end'},
			{name: 'written_premium', type: 'numeric', description: 'Total premium contracted at inception'},
			{
				name: 'earned_premium',
				type: 'numeric',
				description: 'Premium attributable to elapsed cover. THE DENOMINATOR OF LOSS RATIO — never use written_premium for that.'
			},
			{name: 'status', type: 'text', description: 'ACTIVE | EXPIRED | CANCELLED | LAPSED'}
		]
	},
	{
		name: 'premium_payments',
		/**
		 * The direction of the money is stated first and in capitals, deliberately.
		 *
		 * A generated loss triangle joined `claims` to this table because it was hunting
		 * for "payments over time" and this is the only table with a `payment_date` and an
		 * `amount`. The result passed every gate check — one SELECT, whitelisted tables,
		 * whitelisted columns — and was completely wrong: cumulative PREMIUM RECEIPTS
		 * bucketed by claim accident year, presented as paid losses (defect D-42).
		 *
		 * The gate cannot catch that; it proves a statement is safe, not that it answers
		 * the question. The catalogue is the only lever, because it is simultaneously what
		 * the model is told and what the gate permits (CLAUDE.md §4 rule 6).
		 */
		description:
			'Premium RECEIVED FROM the policyholder — money coming IN. Single payments and instalments. This is NOT claim money: it has no connection to claims, losses or payouts, and must never be used to compute paid losses, loss development or a loss triangle.',
		columns: [
			{name: 'id', type: 'integer', description: 'Primary key'},
			{name: 'policy_id', type: 'integer', description: 'FK to policies.id'},
			{name: 'payment_date', type: 'date', description: 'Date received'},
			{name: 'amount', type: 'numeric', description: 'Amount in GHS'},
			{name: 'method', type: 'text', description: 'MOBILE_MONEY | BANK_TRANSFER | CARD | CASH | CHEQUE'}
		]
	},
	{
		name: 'garages',
		description: 'Repair partners who assess and repair claimed vehicles.',
		columns: [
			{name: 'id', type: 'integer', description: 'Primary key'},
			{name: 'name', type: 'text', description: 'Garage name'},
			{name: 'region_id', type: 'integer', description: 'FK to regions.id'},
			{name: 'is_approved', type: 'boolean', description: 'Whether on the approved panel'},
			{name: 'rating', type: 'numeric', description: 'Quality rating, 0–5'}
		]
	},
	{
		name: 'claims',
		description: 'Claims made against policies.',
		columns: [
			{name: 'id', type: 'integer', description: 'Primary key'},
			{name: 'claim_number', type: 'text', description: 'Claim reference'},
			{name: 'policy_id', type: 'integer', description: 'FK to policies.id'},
			{name: 'incident_date', type: 'date', description: 'When the incident occurred'},
			{name: 'notification_date', type: 'date', description: 'When the insurer was told'},
			{name: 'settlement_date', type: 'date', description: 'When settled. NULL if not yet settled.'},
			{name: 'cause', type: 'text', description: 'ACCIDENT | THEFT | FIRE | FLOOD | VANDALISM | THIRD_PARTY'},
			{name: 'status', type: 'text', description: 'SETTLED | OPEN | PENDING | REJECTED'},
			{
				name: 'incurred_amount',
				type: 'numeric',
				description: 'Total cost of the claim. THE NUMERATOR OF LOSS RATIO and of claim severity.'
			},
			{
				name: 'paid_amount',
				type: 'numeric',
				description:
					'Cash paid out on the claim so far — money going OUT. A single cumulative TOTAL with no dates. For WHEN each portion was paid, and therefore for anything involving development periods, use the claim_payments table; its amounts sum to this figure.'
			},
			{name: 'fraud_flag', type: 'boolean', description: 'Flagged as suspected fraud'}
		]
	},
	{
		name: 'claim_payments',
		description:
			'Individual payments made OUT on a claim, each with the date it was paid. This is claim money, not premium. One claim has many rows; they sum to claims.paid_amount. THIS is the table for loss development, development periods and loss triangles — never premium_payments.',
		columns: [
			{name: 'id', type: 'integer', description: 'Primary key'},
			{name: 'claim_id', type: 'integer', description: 'FK to claims.id'},
			{
				name: 'payment_date',
				type: 'date',
				description:
					'Date this portion was paid. Development period = year of payment_date minus year of the claim incident_date; period 0 is payment in the accident year itself.'
			},
			{name: 'amount', type: 'numeric', description: 'Amount of THIS payment in GHS — not the claim total.'},
			{
				name: 'payment_type',
				type: 'text',
				description: 'INTERIM | FINAL. FINAL appears only on a settled claim; an open claim has interims only.'
			}
		]
	},
	{
		name: 'claim_assessments',
		description: 'Garage assessments of claimed vehicles. Roughly 80% of claims reach assessment.',
		columns: [
			{name: 'id', type: 'integer', description: 'Primary key'},
			{name: 'claim_id', type: 'integer', description: 'FK to claims.id'},
			{name: 'garage_id', type: 'integer', description: 'FK to garages.id'},
			{name: 'assessment_date', type: 'date', description: 'Date assessed'},
			{name: 'assessed_amount', type: 'numeric', description: 'Amount the garage quoted'},
			{name: 'approved_amount', type: 'numeric', description: 'Amount the insurer approved'},
			{name: 'labour_hours', type: 'numeric', description: 'Labour hours quoted'}
		]
	}
];

/** What the gate permits as a table reference. */
export const ALLOWED_TABLES: ReadonlySet<string> = new Set(CATALOGUE.map(table => table.name));

/** Every column name in the catalogue, across all tables. */
export const ALLOWED_COLUMNS: ReadonlySet<string> = new Set(
	CATALOGUE.flatMap(table => table.columns.map(column => column.name))
);

/** Columns of one named table — used by the divergence test. */
export function columnsOf(tableName: string): string[] {
	return CATALOGUE.find(table => table.name === tableName)?.columns.map(column => column.name) ?? [];
}

/**
 * The business metric glossary (docs/01 §5.3).
 *
 * This is the control for the principal correctness risk. "Loss ratio" must mean the
 * same thing on every request, or the system produces plausible numbers that are
 * quietly inconsistent between two askings of the same question.
 */
export const METRIC_GLOSSARY: Array<{term: string; definition: string}> = [
	{term: 'Loss ratio', definition: 'SUM(claims.incurred_amount) / SUM(policies.earned_premium) over the same period and filter. Never written_premium.'},
	{term: 'Claim frequency', definition: 'COUNT(claims) / COUNT(policies) over the period. After an outer join use COUNT(claims.id), never COUNT(*).'},
	{term: 'Claim severity', definition: 'SUM(claims.incurred_amount) / COUNT(claims) — the mean cost per claim.'},
	{term: 'Earned premium', definition: 'policies.earned_premium — premium attributable to the elapsed portion of cover. Pre-computed; do not derive it from dates.'},
	{term: 'Written premium', definition: 'policies.written_premium — total premium contracted at inception.'},
	{term: 'Settlement cycle time', definition: 'settlement_date - notification_date in days, for settled claims only (settlement_date IS NOT NULL).'},
	{term: 'Active policy', definition: "A policy whose status is 'ACTIVE'."},
	/**
	 * A glossary entry that exists to prevent a question rather than answer one.
	 *
	 * Loss development is the single most likely actuarial request this schema cannot
	 * support, and the failure is silent: every table needed to fake it exists, so a
	 * model will happily assemble something triangle-shaped out of the wrong quantity.
	 * Saying so plainly is cheaper than any check, because there is no check that could
	 * catch it — a wrong-but-safe query is still safe.
	 */
	{
		term: 'Loss development / loss triangle',
		definition:
			'Use claim_payments joined to claims. Accident year = EXTRACT(YEAR FROM claims.incident_date). Development period = EXTRACT(YEAR FROM claim_payments.payment_date) - EXTRACT(YEAR FROM claims.incident_date), so period 0 is payment in the accident year. Cumulative paid at period N is the SUM of amounts where the development period is <= N. Never build this from premium_payments, which is premium received and not claim money.'
	}
];

/**
 * The schema description sent to the LLM (ADR-06, FR-09).
 *
 * Structure and descriptions only. NEVER table contents: sample rows would export
 * commercially sensitive data to a third-party processor, and the accuracy they would
 * buy is instead bought by the glossary above.
 */
export function renderSchemaForLlm(): string {
	const tables = CATALOGUE.map(table => {
		const columns = table.columns
			.map(column => `    ${column.name} ${column.type} — ${column.description}`)
			.join('\n');
		return `  ${table.name} — ${table.description}\n${columns}`;
	}).join('\n\n');

	const glossary = METRIC_GLOSSARY.map(entry => `  ${entry.term}: ${entry.definition}`).join('\n');

	return `TABLES (these are the only tables that exist; any other name will be refused)\n\n${tables}\n\nMETRIC DEFINITIONS (use these exactly)\n\n${glossary}`;
}
