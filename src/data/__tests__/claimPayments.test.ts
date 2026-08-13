import {DATASET_SEED, generateDataset} from '../generator';

/**
 * `claim_payments` — the development history behind a loss triangle (FR-26).
 *
 * The dataset is deterministic, so these assert exact properties rather than ranges.
 * Generated once and shared: `generateDataset` builds ~70k rows and doing it per test
 * would dominate the suite's runtime for no additional coverage.
 */
const data = generateDataset(DATASET_SEED);

const claimById = new Map<number, any>(data.claims.map((claim: any) => [claim.id, claim]));
const round = (value: number) => Math.round(value * 100) / 100;

describe('payments are a decomposition of paid_amount, not a second opinion on it', () => {
	/**
	 * THE invariant. `claims.paid_amount` and `SUM(claim_payments.amount)` are two paths
	 * to the same quantity, and the product would be answering "how much have we paid"
	 * two different ways if they ever diverged — the exact drift the schema catalogue's
	 * single-source rule exists to prevent, reappearing as data instead of as code.
	 */
	it('sums to the portfolio total paid, exactly', () => {
		const paymentTotal = round(
			data.claimPayments.reduce((sum: number, payment: any) => sum + parseFloat(payment.amount), 0)
		);
		const claimTotal = round(data.claims.reduce((sum: number, claim: any) => sum + parseFloat(claim.paid_amount), 0));

		expect(paymentTotal).toBe(claimTotal);
	});

	it('sums to paid_amount for every individual claim, to the cent', () => {
		const perClaim = new Map<number, number>();
		for (const payment of data.claimPayments as any[]) {
			perClaim.set(payment.claim_id, (perClaim.get(payment.claim_id) ?? 0) + parseFloat(payment.amount));
		}

		const mismatches = [...perClaim.entries()].filter(
			([claimId, total]) => round(total) !== round(parseFloat(claimById.get(claimId).paid_amount))
		);

		expect(mismatches).toEqual([]);
	});

	it('pays nothing on a claim that paid nothing', () => {
		const paidNothing = new Set(
			(data.claims as any[]).filter(claim => parseFloat(claim.paid_amount) === 0).map(claim => claim.id)
		);
		const payments = (data.claimPayments as any[]).filter(payment => paidNothing.has(payment.claim_id));

		expect(payments).toEqual([]);
	});
});

describe('the dates make a development triangle possible', () => {
	it('never pays before the claim was notified', () => {
		const early = (data.claimPayments as any[]).filter(
			payment => payment.payment_date < claimById.get(payment.claim_id).notification_date
		);

		expect(early).toEqual([]);
	});

	it('never pays after settlement on a settled claim', () => {
		const late = (data.claimPayments as any[]).filter(payment => {
			const claim = claimById.get(payment.claim_id);
			return claim.settlement_date && payment.payment_date > claim.settlement_date;
		});

		expect(late).toEqual([]);
	});

	/**
	 * Without this the table is pointless: a triangle whose every payment falls in
	 * development period 0 is a column, not a triangle. Motor is a short-tail line so the
	 * mass IS in periods 0 and 1 — but the open and pending claims have to carry a real
	 * tail beyond it, or nothing can be demonstrated.
	 */
	it('produces payments beyond the accident year', () => {
		const byPeriod = new Map<number, number>();
		for (const payment of data.claimPayments as any[]) {
			const claim = claimById.get(payment.claim_id);
			const period =
				Number(payment.payment_date.slice(0, 4)) - Number(claim.incident_date.slice(0, 4));
			byPeriod.set(period, (byPeriod.get(period) ?? 0) + 1);
		}

		expect(byPeriod.get(0)).toBeGreaterThan(0);
		expect(byPeriod.get(1) ?? 0).toBeGreaterThan(100);
		// Every period must be non-negative — a payment before the accident year would
		// mean the schedule ran backwards.
		expect([...byPeriod.keys()].every(period => period >= 0)).toBe(true);
	});
});

describe('FINAL marks closure, not size', () => {
	it('never marks a payment FINAL on an unsettled claim', () => {
		const wrong = (data.claimPayments as any[]).filter(
			payment => payment.payment_type === 'FINAL' && !claimById.get(payment.claim_id).settlement_date
		);

		expect(wrong).toEqual([]);
	});

	it('gives every settled, part-paid claim exactly one FINAL', () => {
		const finals = new Map<number, number>();
		for (const payment of data.claimPayments as any[]) {
			if (payment.payment_type === 'FINAL') {
				finals.set(payment.claim_id, (finals.get(payment.claim_id) ?? 0) + 1);
			}
		}

		const settledPaid = (data.claims as any[]).filter(
			claim => claim.settlement_date && parseFloat(claim.paid_amount) > 0
		);

		expect(settledPaid.every(claim => finals.get(claim.id) === 1)).toBe(true);
	});
});

describe('determinism', () => {
	/**
	 * The payments pass draws from its OWN generator, seeded separately, precisely so it
	 * cannot shift the draw sequence that produced the claims above it. This asserts the
	 * half that is easy to check — same seed, same rows.
	 */
	it('reproduces exactly from the same seed', () => {
		const again = generateDataset(DATASET_SEED);
		expect(again.claimPayments).toEqual(data.claimPayments);
	});

	/**
	 * The payments pass draws from its OWN generator so it cannot shift the sequence that
	 * produced the claims above it. These two figures are the tripwire: if that ever stops
	 * being true, they move.
	 *
	 * They are exact, not ranges, and they are re-baselined deliberately when the dataset
	 * is deliberately changed — most recently when the period widened to five years and
	 * the portfolio grew (DV-35), which moved them from 0.7525 / 7,312.20. An assertion
	 * that only ever loosens stops being a tripwire.
	 */
	it('did not disturb the figures the project documents', () => {
		const earned = data.policies.reduce((sum: number, policy: any) => sum + parseFloat(policy.earned_premium), 0);
		const incurred = data.claims.reduce((sum: number, claim: any) => sum + parseFloat(claim.incurred_amount), 0);

		expect(incurred / earned).toBeCloseTo(0.7568, 4);
		expect(incurred / data.claims.length).toBeCloseTo(7381.4, 1);
	});
});
