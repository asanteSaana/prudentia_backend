import {loadModule} from 'libpg-query';
import {validateSql} from '../validator';

/**
 * The benign corpus (docs/03 §5.1).
 *
 * Thirteen legitimate analytical queries that MUST be permitted. This holds the OTHER
 * boundary, and it is the one a whitelist model makes easy to fall through: fail closed
 * and you will eventually refuse honest work. A gate that blocks every attack by
 * blocking everything is not a gate, it is an outage.
 *
 * B-06 to B-09 exist specifically because the reference implementation's first working
 * validator rejected them (its defect D-03). Identifiers a query INTRODUCES ITSELF —
 * SELECT aliases, CTE names, table aliases, subquery aliases — are not schema columns,
 * and a column check that does not collect them first will refuse
 * `SELECT COUNT(*) AS n FROM claims ORDER BY n`.
 */

beforeAll(async () => {
	await loadModule();
});

interface BenignCase {
	id: string;
	name: string;
	sql: string;
}

const BENIGN: BenignCase[] = [
	{
		id: 'B-01',
		name: 'Portfolio loss ratio — scalar aggregate over two tables',
		sql: `SELECT SUM(c.incurred_amount) / NULLIF(SUM(p.earned_premium), 0) AS loss_ratio
		        FROM policies p
		        LEFT JOIN claims c ON c.policy_id = p.id`
	},
	{
		id: 'B-02',
		name: 'Monthly claim counts — temporal series with date_trunc',
		sql: `SELECT DATE_TRUNC('month', incident_date) AS month, COUNT(*) AS claim_count
		        FROM claims
		       WHERE incident_date >= DATE '2025-01-01'
		       GROUP BY 1
		       ORDER BY 1`
	},
	{
		id: 'B-03',
		name: 'Average severity by region — four-table join',
		sql: `SELECT r.name AS region, AVG(c.incurred_amount) AS avg_severity
		        FROM claims c
		        JOIN policies p ON p.id = c.policy_id
		        JOIN customers cu ON cu.id = p.customer_id
		        JOIN regions r ON r.id = cu.region_id
		       GROUP BY r.name
		       ORDER BY avg_severity DESC`
	},
	{
		id: 'B-04',
		name: 'Top 10 garages by repair cost — ranked aggregation with LIMIT',
		sql: `SELECT g.name, SUM(a.approved_amount) AS total_cost
		        FROM claim_assessments a
		        JOIN garages g ON g.id = a.garage_id
		       GROUP BY g.name
		       ORDER BY total_cost DESC
		       LIMIT 10`
	},
	{
		id: 'B-05',
		name: 'Loss ratio by vehicle category — CTE',
		sql: `WITH category_claims AS (
		          SELECT v.category, SUM(c.incurred_amount) AS incurred
		            FROM claims c
		            JOIN policies p ON p.id = c.policy_id
		            JOIN vehicles v ON v.id = p.vehicle_id
		           GROUP BY v.category
		      )
		      SELECT category, incurred FROM category_claims ORDER BY incurred DESC`
	},
	{
		id: 'B-06',
		name: 'SELECT alias used in ORDER BY — the D-03 case',
		sql: 'SELECT COUNT(*) AS n FROM claims ORDER BY n'
	},
	{
		id: 'B-07',
		name: 'SELECT alias used in HAVING',
		sql: `SELECT policy_id, COUNT(*) AS claim_count
		        FROM claims
		       GROUP BY policy_id
		      HAVING COUNT(*) > 2
		       ORDER BY claim_count DESC`
	},
	{
		id: 'B-08',
		name: 'Subquery in FROM with its own alias',
		sql: `SELECT sub.cause, sub.total
		        FROM (SELECT cause, SUM(incurred_amount) AS total FROM claims GROUP BY cause) AS sub
		       ORDER BY sub.total DESC`
	},
	{
		id: 'B-09',
		name: 'Table aliases throughout, alias-qualified columns',
		sql: `SELECT p.channel AS ch, COUNT(c.id) AS n
		        FROM policies p
		        LEFT JOIN claims c ON c.policy_id = p.id
		       GROUP BY p.channel
		       ORDER BY n DESC`
	},
	{
		id: 'B-10',
		name: 'CASE expression and boolean filter',
		sql: `SELECT CASE WHEN fraud_flag THEN 'flagged' ELSE 'clean' END AS bucket,
		             AVG(settlement_date - notification_date) AS mean_days
		        FROM claims
		       WHERE settlement_date IS NOT NULL
		       GROUP BY 1`
	},
	{
		id: 'B-11',
		name: 'Window function over a whitelisted table',
		sql: `SELECT claim_number, incurred_amount,
		             RANK() OVER (ORDER BY incurred_amount DESC) AS severity_rank
		        FROM claims
		       LIMIT 20`
	},
	{
		id: 'B-12',
		name: 'Correlated comparison against a computed baseline — Q9',
		sql: `SELECT g.name, AVG(a.approved_amount) AS mean_cost
		        FROM claim_assessments a
		        JOIN garages g ON g.id = a.garage_id
		       GROUP BY g.name
		      HAVING AVG(a.approved_amount) > (SELECT AVG(approved_amount) * 1.5 FROM claim_assessments)`
	},
	{
		id: 'B-13',
		name: 'UNION ALL of two whitelisted selects',
		sql: `SELECT 'settled' AS bucket, COUNT(*) AS n FROM claims WHERE status = 'SETTLED'
		       UNION ALL
		      SELECT 'open' AS bucket, COUNT(*) AS n FROM claims WHERE status = 'OPEN'`
	}
];

describe('benign corpus — every case must be PERMITTED', () => {
	test.each(BENIGN.map(benign => [benign.id, benign.name, benign.sql]))(
		'%s %s',
		async (id, _name, sql) => {
			const result = await validateSql(sql as string);

			// Surface the reason on failure — a benign rejection is a usability defect
			// and the failed check is what tells you which rule over-reached.
			if (!result.permitted) {
				throw new Error(`${id} was REJECTED (${result.failedCheck}): ${result.reason}`);
			}

			expect(result.permitted).toBe(true);
			expect(result.normalisedSql).toBeTruthy();
			expect(result.failedCheck).toBeNull();
		}
	);

	it('holds all 13 cases', () => {
		expect(BENIGN).toHaveLength(13);
		expect(new Set(BENIGN.map(benign => benign.id)).size).toBe(13);
	});
});
