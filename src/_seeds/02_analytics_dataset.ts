import type {Knex} from 'knex';
import {ANALYTICS_TABLE_ORDER} from '../_services/_dbTables';
import {DATASET_SEED, generateDataset} from '../data/generator';

/**
 * The synthetic portfolio (FR-26, FR-27).
 *
 * Deterministic: one fixed seed, no `Math.random()`, no wall-clock reads. Re-running
 * this against an empty database reproduces the dataset exactly, which is what lets the
 * test suite assert figures rather than ranges.
 */
export async function seed(knex: Knex): Promise<void> {
	const started = Date.now();

	// Reverse dependency order — foreign keys forbid anything else.
	for (const table of [...ANALYTICS_TABLE_ORDER].reverse()) {
		await knex(table).del();
	}

	const data = generateDataset(DATASET_SEED);

	// batchInsert rather than a single insert: 30,000 premium payments in one statement
	// exceeds the driver's parameter limit, and chunking by hand is what batchInsert is.
	const CHUNK = 1000;
	await knex.batchInsert('regions', data.regions, CHUNK);
	await knex.batchInsert('customers', data.customers, CHUNK);
	await knex.batchInsert('vehicles', data.vehicles, CHUNK);
	await knex.batchInsert('policies', data.policies, CHUNK);
	await knex.batchInsert('premium_payments', data.premiumPayments, CHUNK);
	await knex.batchInsert('garages', data.garages, CHUNK);
	await knex.batchInsert('claims', data.claims, CHUNK);
	await knex.batchInsert('claim_assessments', data.claimAssessments, CHUNK);

	// Explicit ids were inserted, so the sequences still sit at 1 and the next natural
	// insert would collide. Resetting them here is not optional.
	for (const table of ANALYTICS_TABLE_ORDER) {
		await knex.raw(
			`SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1));`,
			[table]
		);
	}

	const total =
		data.regions.length +
		data.customers.length +
		data.vehicles.length +
		data.policies.length +
		data.premiumPayments.length +
		data.garages.length +
		data.claims.length +
		data.claimAssessments.length;

	console.log(
		`Seeded ${total.toLocaleString()} analytics rows in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
			`(seed ${DATASET_SEED}).`
	);
	console.table({
		regions: data.regions.length,
		customers: data.customers.length,
		vehicles: data.vehicles.length,
		policies: data.policies.length,
		premium_payments: data.premiumPayments.length,
		garages: data.garages.length,
		claims: data.claims.length,
		claim_assessments: data.claimAssessments.length
	});
}
