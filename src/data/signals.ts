import {Knex} from 'knex';

/**
 * Verification of the six planted signals (FR-27), plus two calibration checks.
 *
 * These queries are written INDEPENDENTLY of the generator — they measure the database,
 * not the code that filled it. That is the whole value: a generator asserting its own
 * intent proves nothing, and a signal nobody can detect is not a signal.
 *
 * Two arithmetic notes, because both have produced defects before:
 *
 *  - **Loss ratio is computed from separately aggregated sums, never across a join.**
 *    `FROM policies LEFT JOIN claims` duplicates a policy's earned premium once per
 *    claim, inflating the denominator for multi-claim policies. The pipeline tolerates
 *    that pattern because it is what an LLM generates most reliably (debt TD-M), but
 *    the reference figures here must be exact, so they use scalar subqueries instead.
 *
 *  - **Counting claims after an outer join uses COUNT(claim column), never COUNT(*).**
 *    `COUNT(*)` counts claimless policies as claims. That was defect D-01 in the
 *    reference build — a bug in the *test*, not the system — and it under-measured the
 *    channel-frequency signal by a factor of six.
 */

export interface SignalResult {
	id: string;
	name: string;
	expectation: string;
	measured: string;
	pass: boolean;
}

const number = (value: any): number => (value === null || value === undefined ? 0 : parseFloat(value));

export async function verifySignals(knex: Knex): Promise<SignalResult[]> {
	return [
		await p1NorthernDeterioration(knex),
		await p2OutlierGarages(knex),
		await p3RainySeasonPeak(knex),
		await p4ComprehensiveSuvUnprofitable(knex),
		await p5BrokerChannelFrequency(knex),
		await p6FraudSettlementDrag(knex),
		await p7PortfolioLossRatio(knex),
		await p8ClaimFrequency(knex)
	];
}

/** P1 — Northern zone claim severity rises across the four quarters of 2025. */
async function p1NorthernDeterioration(knex: Knex): Promise<SignalResult> {
	const {rows} = await knex.raw(`
		SELECT EXTRACT(QUARTER FROM c.incident_date)::int AS quarter,
		       COUNT(*)::int                             AS claims,
		       AVG(c.incurred_amount)                    AS avg_severity
		  FROM claims c
		  JOIN policies p  ON p.id = c.policy_id
		  JOIN customers cu ON cu.id = p.customer_id
		  JOIN regions r    ON r.id = cu.region_id
		 WHERE r.zone = 'NORTHERN'
		   AND c.incident_date >= DATE '2025-01-01'
		   AND c.incident_date <  DATE '2026-01-01'
		 GROUP BY 1
		 ORDER BY 1
	`);

	const quarters = rows.map((row: any) => number(row.avg_severity));
	const claimCount = rows.reduce((sum: number, row: any) => sum + row.claims, 0);
	const ratio = quarters.length === 4 && quarters[0] > 0 ? quarters[3] / quarters[0] : 0;

	return {
		id: 'P1',
		name: 'Northern zone 2025 severity ramp',
		expectation: 'Q4 ≥ 1.8× Q1, rising across four quarters',
		measured:
			quarters.length === 4
				? `${quarters.map((value: number) => Math.round(value).toLocaleString()).join(' → ')} GHS ` +
					`(Q4/Q1 = ${ratio.toFixed(2)}×, n=${claimCount})`
				: `only ${quarters.length} quarters present`,
		pass: quarters.length === 4 && ratio >= 1.8
	};
}

/** P2 — three named garages approve repairs well above the national mean. */
async function p2OutlierGarages(knex: Knex): Promise<SignalResult> {
	const {rows} = await knex.raw(`
		WITH per_garage AS (
			SELECT g.name, AVG(a.approved_amount) AS mean_approved
			  FROM claim_assessments a
			  JOIN garages g ON g.id = a.garage_id
			 GROUP BY g.name
		)
		SELECT (SELECT AVG(mean_approved) FROM per_garage) AS national_mean,
		       (SELECT AVG(mean_approved) FROM per_garage
		         WHERE name IN ('Suame Autobody', 'Kaneshie Panel Beaters', 'Tema Motors')) AS outlier_mean
	`);

	const nationalMean = number(rows[0].national_mean);
	const outlierMean = number(rows[0].outlier_mean);
	const ratio = nationalMean > 0 ? outlierMean / nationalMean : 0;

	return {
		id: 'P2',
		name: 'Three outlier garages',
		expectation: 'mean approved cost ≥ 1.5× the national mean',
		measured: `${Math.round(outlierMean).toLocaleString()} vs ${Math.round(nationalMean).toLocaleString()} GHS = ${ratio.toFixed(2)}×`,
		pass: ratio >= 1.5
	};
}

/** P3 — claim volume peaks in the rainy season. */
async function p3RainySeasonPeak(knex: Knex): Promise<SignalResult> {
	const {rows} = await knex.raw(`
		SELECT
			COUNT(*) FILTER (WHERE EXTRACT(MONTH FROM incident_date) BETWEEN 6 AND 8)::int AS jun_aug,
			COUNT(*) FILTER (WHERE EXTRACT(MONTH FROM incident_date) BETWEEN 1 AND 3)::int AS jan_mar
		  FROM claims
	`);

	const junAug = rows[0].jun_aug;
	const janMar = rows[0].jan_mar;
	const ratio = janMar > 0 ? junAug / janMar : 0;

	return {
		id: 'P3',
		name: 'Rainy-season claim peak',
		expectation: 'Jun–Aug ≥ 1.5× Jan–Mar',
		measured: `${junAug.toLocaleString()} vs ${janMar.toLocaleString()} = ${ratio.toFixed(2)}×`,
		pass: ratio >= 1.5
	};
}

/** P4 — comprehensive cover on SUV and PICKUP runs at a loss. */
async function p4ComprehensiveSuvUnprofitable(knex: Knex): Promise<SignalResult> {
	const {rows} = await knex.raw(`
		SELECT
			(SELECT COALESCE(SUM(c.incurred_amount), 0)
			   FROM claims c
			   JOIN policies p ON p.id = c.policy_id
			   JOIN vehicles v ON v.id = p.vehicle_id
			  WHERE p.product_type = 'COMPREHENSIVE' AND v.category IN ('SUV', 'PICKUP')) AS incurred,
			(SELECT COALESCE(SUM(p.earned_premium), 0)
			   FROM policies p
			   JOIN vehicles v ON v.id = p.vehicle_id
			  WHERE p.product_type = 'COMPREHENSIVE' AND v.category IN ('SUV', 'PICKUP')) AS earned
	`);

	const incurred = number(rows[0].incurred);
	const earned = number(rows[0].earned);
	const lossRatio = earned > 0 ? incurred / earned : 0;

	return {
		id: 'P4',
		name: 'Comprehensive SUV/PICKUP unprofitable',
		expectation: 'loss ratio > 1.0',
		measured: lossRatio.toFixed(3),
		pass: lossRatio > 1.0
	};
}

/** P5 — broker business claims more often than direct. */
async function p5BrokerChannelFrequency(knex: Knex): Promise<SignalResult> {
	const {rows} = await knex.raw(`
		SELECT p.channel,
		       COUNT(DISTINCT p.id)::int AS policies,
		       -- COUNT(c.id), never COUNT(*): after an outer join COUNT(*) counts
		       -- claimless policies as claims. This was defect D-01.
		       COUNT(c.id)::int          AS claims
		  FROM policies p
		  LEFT JOIN claims c ON c.policy_id = p.id
		 GROUP BY p.channel
	`);

	const byChannel: Record<string, number> = {};
	for (const row of rows) {
		byChannel[row.channel] = row.policies > 0 ? row.claims / row.policies : 0;
	}

	const broker = byChannel['BROKER'] ?? 0;
	const direct = byChannel['DIRECT'] ?? 0;
	const delta = broker - direct;

	return {
		id: 'P5',
		name: 'Broker channel frequency premium',
		expectation: 'broker − direct ≥ +0.03',
		measured: `broker ${broker.toFixed(3)} vs direct ${direct.toFixed(3)} = ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`,
		pass: delta >= 0.03
	};
}

/** P6 — fraud-flagged claims take far longer to settle. */
async function p6FraudSettlementDrag(knex: Knex): Promise<SignalResult> {
	const {rows} = await knex.raw(`
		SELECT fraud_flag,
		       AVG(settlement_date - notification_date) AS mean_days,
		       COUNT(*)::int                            AS settled
		  FROM claims
		 WHERE settlement_date IS NOT NULL
		 GROUP BY fraud_flag
	`);

	const fraud = number(rows.find((row: any) => row.fraud_flag === true)?.mean_days);
	const clean = number(rows.find((row: any) => row.fraud_flag === false)?.mean_days);
	const ratio = clean > 0 ? fraud / clean : 0;

	return {
		id: 'P6',
		name: 'Fraud settlement drag',
		expectation: 'fraud-flagged ≥ 1.8× clean claims',
		measured: `${fraud.toFixed(1)} vs ${clean.toFixed(1)} days = ${ratio.toFixed(2)}×`,
		pass: ratio >= 1.8
	};
}

/** P7 — the portfolio loss ratio is commercially plausible (calibration check). */
async function p7PortfolioLossRatio(knex: Knex): Promise<SignalResult> {
	const {rows} = await knex.raw(`
		SELECT (SELECT COALESCE(SUM(incurred_amount), 0) FROM claims)   AS incurred,
		       (SELECT COALESCE(SUM(earned_premium), 0)  FROM policies) AS earned
	`);

	const lossRatio = number(rows[0].earned) > 0 ? number(rows[0].incurred) / number(rows[0].earned) : 0;

	return {
		id: 'P7',
		name: 'Portfolio loss ratio',
		expectation: '0.70 – 0.85 (realistic for a motor book)',
		measured: lossRatio.toFixed(3),
		pass: lossRatio >= 0.7 && lossRatio <= 0.85
	};
}

/** P8 — claim frequency is commercially plausible (calibration check). */
async function p8ClaimFrequency(knex: Knex): Promise<SignalResult> {
	const {rows} = await knex.raw(`
		SELECT (SELECT COUNT(*) FROM claims)::numeric   AS claims,
		       (SELECT COUNT(*) FROM policies)::numeric AS policies
	`);

	const frequency = number(rows[0].policies) > 0 ? number(rows[0].claims) / number(rows[0].policies) : 0;

	return {
		id: 'P8',
		name: 'Claim frequency',
		expectation: '0.26 – 0.34 claims per policy',
		measured: frequency.toFixed(3),
		pass: frequency >= 0.26 && frequency <= 0.34
	};
}
