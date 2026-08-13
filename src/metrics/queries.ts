import {Knex} from 'knex';

/**
 * The headline metrics (FR-22, NFR-09, NFR-12).
 *
 * ── These are HAND-WRITTEN and never touch the LLM ───────────────────────────
 *
 * Three consequences follow, and all three are the point:
 *
 *  1. **They are exact.** Every figure below is computed from separately aggregated
 *     sums, NOT across a join. `FROM policies LEFT JOIN claims` duplicates a policy's
 *     earned premium once per claim and understates the loss ratio by a bounded amount
 *     (measured at 2.86%, debt TD-M). The pipeline tolerates that pattern because it is
 *     what a model generates most reliably; the dashboard must not, because these are
 *     the numbers the user manual tells people they can rely on.
 *
 *  2. **They stay available when the provider does not** (NFR-12). Nothing here has a
 *     dependency on the model layer, so an outage degrades conversational queries and
 *     leaves the dashboard intact.
 *
 *  3. **They carry no user input.** Every statement is a fixed string literal with no
 *     interpolation and no parameters — there is no value a caller could influence.
 *     The `no-generated-sql-outside-guard` lint rule permits `.raw()` here precisely
 *     because these are literals; the moment one took a variable it would fail the lint.
 *
 * NULL handling is explicit throughout. An empty portfolio must return 0, not NULL —
 * a dashboard tile reading "null" is a bug report, and `NULLIF` on every denominator is
 * what stops a division by zero becoming one.
 */

export interface HeadlineMetrics {
	lossRatio: number;
	claimFrequency: number;
	averageSeverity: number;
	earnedPremium: number;
	activePolicies: number;
	averageSettlementDays: number;
}

export interface TrendPoint {
	month: string;
	claimCount: number;
	incurredAmount: number;
}

const asNumber = (value: unknown): number => {
	if (value === null || value === undefined) return 0;
	const parsed = typeof value === 'number' ? value : parseFloat(String(value));
	return Number.isFinite(parsed) ? parsed : 0;
};

export namespace MetricsQuery {
	/**
	 * All six figures in ONE round trip.
	 *
	 * Six separate queries would be clearer to read and would also mean the tiles could
	 * disagree with each other: a claim settled between the first and last query would
	 * be counted by some figures and not others. One statement gives every tile the same
	 * snapshot, which matters when a user is reading them as a set.
	 */
	export async function headline(knex: Knex): Promise<HeadlineMetrics> {
		const {rows} = await knex.raw(`
			SELECT
				-- Loss ratio: incurred over EARNED premium (never written) — the glossary's
				-- definition, computed from independent sums so no join inflates either side.
				COALESCE(
					(SELECT SUM(incurred_amount) FROM claims)
					/ NULLIF((SELECT SUM(earned_premium) FROM policies), 0),
				0) AS loss_ratio,

				-- Claim frequency: claims per policy.
				COALESCE(
					(SELECT COUNT(*) FROM claims)::numeric
					/ NULLIF((SELECT COUNT(*) FROM policies), 0),
				0) AS claim_frequency,

				-- Severity: mean incurred cost per claim.
				COALESCE(
					(SELECT SUM(incurred_amount) FROM claims)
					/ NULLIF((SELECT COUNT(*) FROM claims), 0),
				0) AS average_severity,

				COALESCE((SELECT SUM(earned_premium) FROM policies), 0) AS earned_premium,

				(SELECT COUNT(*) FROM policies WHERE status = 'ACTIVE') AS active_policies,

				-- Settlement cycle time is defined over SETTLED claims only. Without the
				-- NOT NULL filter the average would silently be taken over a different
				-- population than the one the glossary names.
				COALESCE(
					(SELECT AVG(settlement_date - notification_date)
					   FROM claims
					  WHERE settlement_date IS NOT NULL),
				0) AS average_settlement_days
		`);

		const row = rows[0] ?? {};

		return {
			lossRatio: asNumber(row.loss_ratio),
			claimFrequency: asNumber(row.claim_frequency),
			averageSeverity: asNumber(row.average_severity),
			earnedPremium: asNumber(row.earned_premium),
			activePolicies: asNumber(row.active_policies),
			averageSettlementDays: asNumber(row.average_settlement_days)
		};
	}

	/**
	 * Monthly claim counts and incurred amounts (deviation DV-5 in the reference build,
	 * carried forward: the dashboard needs a temporal series).
	 *
	 * Grouped on incident_date rather than notification_date — the month a loss occurred
	 * is the month an underwriter is asking about, and notification lag would smear a
	 * seasonal peak across a boundary.
	 */
	export async function trend(knex: Knex): Promise<TrendPoint[]> {
		const {rows} = await knex.raw(`
			SELECT TO_CHAR(DATE_TRUNC('month', incident_date), 'YYYY-MM') AS month,
			       COUNT(*)                        AS claim_count,
			       COALESCE(SUM(incurred_amount), 0) AS incurred_amount
			  FROM claims
			 GROUP BY DATE_TRUNC('month', incident_date)
			 ORDER BY DATE_TRUNC('month', incident_date)
		`);

		return rows.map((row: Record<string, unknown>) => ({
			month: String(row.month),
			claimCount: asNumber(row.claim_count),
			incurredAmount: asNumber(row.incurred_amount)
		}));
	}
}
