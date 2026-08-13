import {config} from 'dotenv';
config();

import {ANALYTICS_TABLE_ORDER} from '../src/_services/_dbTables';
import {Database} from '../src/_services/databaseService';
import {verifySignals} from '../src/data/signals';

/**
 * Prints every planted signal's measured value against its expectation (FR-27).
 *
 * Generating data and hoping it is interesting is not engineering. If a signal fails
 * here, fix the GENERATOR — never lower the expectation. An expectation relaxed until
 * the data passes is an expectation that measures nothing.
 *
 *   npm run verify:signals
 */
async function main(): Promise<void> {
	const knex = Database.getInstance();

	try {
		console.log('\nRow counts');
		console.log('─'.repeat(72));
		let total = 0;
		for (const table of ANALYTICS_TABLE_ORDER) {
			const [{count}] = (await knex.raw(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows;
			total += count;
			console.log(`  ${table.padEnd(20)} ${count.toLocaleString().padStart(10)}`);
		}
		console.log(`  ${'TOTAL'.padEnd(20)} ${total.toLocaleString().padStart(10)}`);

		console.log('\nPlanted signals');
		console.log('─'.repeat(72));

		const results = await verifySignals(knex);
		for (const result of results) {
			const mark = result.pass ? 'PASS' : 'FAIL';
			console.log(`\n  ${result.id}  ${result.name}  [${mark}]`);
			console.log(`      expected: ${result.expectation}`);
			console.log(`      measured: ${result.measured}`);
		}

		const failed = results.filter(result => !result.pass);
		console.log('\n' + '─'.repeat(72));
		console.log(`  ${results.length - failed.length}/${results.length} signals present.`);

		if (failed.length > 0) {
			console.log(`  FAILING: ${failed.map(result => result.id).join(', ')}`);
			console.log('  Fix the generator, not the expectation.\n');
			process.exitCode = 1;
		} else {
			console.log('  All signals verified.\n');
		}
	} finally {
		await knex.destroy();
	}
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
