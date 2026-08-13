import {ChartType} from '../_typings/types';
import {LlmProvider, ProviderResponse} from './types';

/**
 * The deterministic provider (NFR-12, ADR-05).
 *
 * **This is a design element, not a test double.** It makes the entire pipeline —
 * context, validation, execution, chart reconciliation, auditing — runnable offline,
 * deterministically, at zero API cost, and it is the graceful-degradation path when the
 * real provider cannot be constructed. Every test in the suite except the Claude adapter
 * itself runs against it.
 *
 * ── ORDER IS LOAD-BEARING. READ THIS BEFORE ADDING A FIXTURE. ────────────────
 *
 * Matching is FIRST-MATCH-WINS, so fixtures must be ordered MOST-SPECIFIC FIRST.
 *
 * The reference implementation shipped defect **D-02** because a generic `["loss ratio"]`
 * fixture sat above the `["loss ratio", "category"]` one. "Compare loss ratio by vehicle
 * category" matched the generic fixture and returned the portfolio-wide figure — a
 * confidently wrong answer to a question the application itself suggested. The automated
 * suite was fully green; a human looking at a screenshot found it.
 *
 * A fixture whose keywords are a SUBSET of another fixture's must appear BELOW it.
 * `__tests__/stubProvider.test.ts` asserts exactly that, so a mis-ordered addition fails
 * the build rather than shipping a wrong answer.
 */

interface Fixture {
	/** ALL of these must appear in the lower-cased question. */
	keywords: string[];
	response: ProviderResponse;
}

const sqlFixture = (
	keywords: string[],
	sql: string,
	chartType: ChartType,
	explanation: string
): Fixture => ({
	keywords,
	response: {kind: 'sql', sql: sql.trim(), chartType, explanation}
});

const declineFixture = (keywords: string[], reason: string): Fixture => ({
	keywords,
	response: {kind: 'decline', reason}
});

export const FIXTURES: Fixture[] = [
	// ── Declines first ───────────────────────────────────────────────────────
	// Destructive and credential-seeking questions are matched before anything
	// else so no phrasing can fall through to a fixture that would run SQL.
	declineFixture(['delete'], 'The question asks to change data. This system can only read.'),
	declineFixture(['drop'], 'The question asks to remove data. This system can only read.'),
	declineFixture(['update'], 'The question asks to change data. This system can only read.'),
	declineFixture(['truncate'], 'The question asks to remove data. This system can only read.'),
	declineFixture(['password'], 'Credentials are not part of the analytics schema.'),
	declineFixture(['user account'], 'User accounts are not part of the analytics schema.'),
	declineFixture(['audit log'], 'The audit log is not part of the analytics schema.'),

	// ── Specific before general ──────────────────────────────────────────────
	// D-02's exact case: this MUST sit above the bare "loss ratio" fixture.
	sqlFixture(
		['loss ratio', 'category'],
		`SELECT v.category,
		        SUM(c.incurred_amount) / NULLIF(SUM(p.earned_premium), 0) AS loss_ratio
		   FROM policies p
		   JOIN vehicles v ON v.id = p.vehicle_id
		   LEFT JOIN claims c ON c.policy_id = p.id
		  GROUP BY v.category
		  ORDER BY loss_ratio DESC`,
		'bar',
		'Loss ratio by vehicle category: incurred claims divided by earned premium, grouped by category.'
	),
	sqlFixture(
		['loss ratio', 'region'],
		`SELECT r.name AS region,
		        SUM(c.incurred_amount) / NULLIF(SUM(p.earned_premium), 0) AS loss_ratio
		   FROM policies p
		   JOIN customers cu ON cu.id = p.customer_id
		   JOIN regions r ON r.id = cu.region_id
		   LEFT JOIN claims c ON c.policy_id = p.id
		  GROUP BY r.name
		  ORDER BY loss_ratio DESC`,
		'bar',
		'Loss ratio by region, reached through policies to customers to regions.'
	),
	sqlFixture(
		['claim frequency', 'channel'],
		`SELECT p.channel, COUNT(c.id)::numeric / NULLIF(COUNT(DISTINCT p.id), 0) AS claim_frequency
		   FROM policies p
		   LEFT JOIN claims c ON c.policy_id = p.id
		  GROUP BY p.channel
		  ORDER BY claim_frequency DESC`,
		'bar',
		'Claims per policy by distribution channel. Counts claim ids, not rows, so claimless policies are not miscounted.'
	),
	sqlFixture(
		['severity', 'region'],
		`SELECT r.name AS region, AVG(c.incurred_amount) AS avg_severity
		   FROM claims c
		   JOIN policies p ON p.id = c.policy_id
		   JOIN customers cu ON cu.id = p.customer_id
		   JOIN regions r ON r.id = cu.region_id
		  GROUP BY r.name
		  ORDER BY avg_severity DESC`,
		'bar',
		'Average incurred claim amount per claim, grouped by customer region.'
	),
	sqlFixture(
		['claims', 'month'],
		`SELECT DATE_TRUNC('month', incident_date) AS month, COUNT(*) AS claim_count
		   FROM claims
		  WHERE incident_date >= DATE '2025-01-01' AND incident_date < DATE '2026-01-01'
		  GROUP BY 1
		  ORDER BY 1`,
		'line',
		'Number of claims by incident month during 2025.'
	),
	sqlFixture(
		['garages', 'repair cost'],
		`SELECT g.name, SUM(a.approved_amount) AS total_repair_cost
		   FROM claim_assessments a
		   JOIN garages g ON g.id = a.garage_id
		  GROUP BY g.name
		  ORDER BY total_repair_cost DESC
		  LIMIT 10`,
		'bar',
		'Top 10 garages by total approved repair cost.'
	),
	sqlFixture(
		['notification', 'settlement'],
		`SELECT AVG(settlement_date - notification_date) AS avg_days_to_settle
		   FROM claims
		  WHERE settlement_date IS NOT NULL`,
		'kpi',
		'Mean days from claim notification to settlement, over settled claims only.'
	),
	sqlFixture(
		['policies', 'more than two claims'],
		`SELECT p.policy_number, COUNT(c.id) AS claim_count
		   FROM policies p
		   JOIN claims c ON c.policy_id = p.id
		  GROUP BY p.policy_number
		 HAVING COUNT(c.id) > 2
		  ORDER BY claim_count DESC`,
		'table',
		'Policies with more than two claims, with their claim counts.'
	),
	sqlFixture(
		['claim frequency'],
		`SELECT COUNT(c.id)::numeric / NULLIF(COUNT(DISTINCT p.id), 0) AS claim_frequency
		   FROM policies p
		   LEFT JOIN claims c ON c.policy_id = p.id`,
		'kpi',
		'Claims per policy across the portfolio.'
	),
	sqlFixture(
		['fraud'],
		`SELECT fraud_flag, AVG(settlement_date - notification_date) AS avg_days_to_settle
		   FROM claims
		  WHERE settlement_date IS NOT NULL
		  GROUP BY fraud_flag`,
		'bar',
		'Mean settlement time for fraud-flagged claims against the rest, over settled claims only.'
	),

	// ── The generic fixture. LAST, deliberately. ─────────────────────────────
	// Anything whose keywords are a subset of a fixture above must sit below it.
	sqlFixture(
		['loss ratio'],
		`SELECT SUM(c.incurred_amount) / NULLIF(SUM(p.earned_premium), 0) AS loss_ratio
		   FROM policies p
		   LEFT JOIN claims c ON c.policy_id = p.id`,
		'kpi',
		'Portfolio loss ratio: total incurred claims divided by total earned premium.'
	)
];

export class StubProvider implements LlmProvider {
	name(): string {
		return 'stub';
	}

	async generate(question: string): Promise<ProviderResponse> {
		const normalised = question.toLowerCase();

		for (const fixture of FIXTURES) {
			if (fixture.keywords.every(keyword => normalised.includes(keyword))) {
				return fixture.response;
			}
		}

		/**
		 * No fixture matched. The stub DECLINES rather than guessing — a stub that
		 * invented SQL for an unrecognised question would answer confidently and wrongly,
		 * which is the exact failure mode the whole design exists to prevent.
		 */
		return {
			kind: 'decline',
			reason: `No stub fixture matched the question. Provider is ${this.name()}.`
		};
	}
}
