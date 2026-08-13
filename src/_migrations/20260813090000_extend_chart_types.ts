import type {Knex} from 'knex';
import {asCheck, ChartTypes} from '../_typings/dbEnums';

/**
 * Widen `query_log.chart_type` to the extended presentation vocabulary.
 *
 * `hbar`, `area` and `donut` join `kpi | bar | line | table`. The column is varchar(10)
 * with a CHECK rather than a Postgres enum type — the template estate's convention —
 * precisely so that widening it is a constraint change and not a type migration, and the
 * longest new value (`donut`, 5) is well inside the existing length.
 *
 * ── Why this must be a migration and not just an enum edit ───────────────────
 *
 * `dbEnums.ts` is the single source for three things that must not drift: this CHECK, the
 * generator's draws, and the value lists the LLM is shown (see the header of that file).
 * Adding a value to the tuple without moving the constraint would produce the exact
 * failure it warns about — a chart type the model is told exists, that the reconciler
 * happily selects, and that then fails at INSERT when the attempt is audited. The audit
 * write is the last step of a successful query, so the query would run, return, and *then*
 * fail: the worst possible place to discover it.
 */

const CONSTRAINT = 'query_log_chart_type_check';

export async function up(knex: Knex): Promise<void> {
	await knex.schema.alterTable('query_log', table => {
		table.dropChecks(CONSTRAINT);
	});

	await knex.schema.alterTable('query_log', table => {
		table.string('chart_type', 10).nullable().checkIn(asCheck(ChartTypes), CONSTRAINT).alter();
	});
}

export async function down(knex: Knex): Promise<void> {
	/**
	 * Reverting NARROWS the constraint, so rows already recorded with one of the new
	 * values would violate it. They are set to NULL first — `chart_type` is nullable by
	 * design (a rejected question has no chart), and losing a presentation hint from a
	 * historical audit row costs nothing, whereas a `down` that cannot run costs the
	 * ability to roll back at all.
	 */
	await knex('query_log').whereIn('chart_type', ['hbar', 'area', 'donut']).update({chart_type: null});

	await knex.schema.alterTable('query_log', table => {
		table.dropChecks(CONSTRAINT);
	});

	await knex.schema.alterTable('query_log', table => {
		table.string('chart_type', 10).nullable().checkIn(['kpi', 'bar', 'line', 'table'], CONSTRAINT).alter();
	});
}
