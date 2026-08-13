import {mulberry32} from '../_services/utilities';
import {
	CATEGORY_MAKES,
	CATEGORY_MIX,
	CAUSE_MIX,
	CHANNEL_MIX,
	ENGINE_BANDS,
	GARAGE_PREFIXES,
	GARAGE_SUFFIXES,
	OUTLIER_GARAGE_NAMES,
	PAYMENT_METHOD_MIX,
	PRODUCT_MIX,
	REGIONS,
	SEGMENT_MIX,
	VALUE_BANDS,
	VEHICLE_MAKES
} from './referenceData';

/**
 * The synthetic motor-insurance portfolio (FR-26, FR-27, docs/02 §5.4).
 *
 * Two properties matter more than realism:
 *
 *  1. **Reproducibility.** One fixed seed, one PRNG threaded through every draw, no
 *     `Math.random()` and no `Date.now()`. The test suite asserts exact figures against
 *     this data, so the same seed must yield byte-identical output on any machine.
 *
 *  2. **Detectable signals.** Generating plausible data and hoping it is interesting is
 *     not engineering. Six signals are planted deliberately (P1–P6) and each is
 *     verifiable by an independent reference query in `signals.ts`.
 *
 * ── Calibration, and why it is a second pass ──────────────────────────────────
 *
 * Premium rates and claim severities were originally chosen independently, which is how
 * the reference implementation produced a portfolio loss ratio of 7.7 — arithmetically
 * valid, commercially absurd (its defect D-04). Choosing both by hand and hoping they
 * meet in the middle does not work.
 *
 * Instead severity is generated in *relative* terms and then scaled once, globally, so
 * the portfolio lands on TARGET_LOSS_RATIO exactly. A uniform scale preserves every
 * ratio between segments, so the planted signals survive it untouched — P4's
 * comprehensive-SUV segment stays at ~1.4× the portfolio whatever the portfolio is.
 */

/** Fixed seed. Changing this changes the dataset and invalidates asserted figures. */
export const DATASET_SEED = 20260812;

/** Realistic for a Ghanaian motor book, and the figure Phase 5's checkpoint expects. */
const TARGET_LOSS_RATIO = 0.78;

/**
 * The data period. Widened from three years to FIVE (deviation DV-35).
 *
 * Three accident years made a loss development triangle three rows tall and every
 * year-on-year question a single comparison. Five gives the triangle a shape worth
 * reading, sixty months of seasonality rather than thirty-six, and enough history for
 * "how has this changed" to have an answer.
 *
 * AS_AT is unchanged, so the widening is BACKWARDS. Extending forwards would have
 * invented claims that have not happened yet and quietly moved the earned-premium
 * arithmetic, which every headline figure rests on.
 */
const PERIOD_START = new Date(Date.UTC(2021, 0, 1));
const PERIOD_END = new Date(Date.UTC(2025, 11, 31));
/** "Today" for earned-premium arithmetic. Fixed, so earned premium is reproducible. */
const AS_AT = new Date(Date.UTC(2025, 11, 31));

/**
 * Portfolio size (deviation DV-35).
 *
 * Roughly 1.8× the original, which matters for the questions rather than for the totals:
 * a query that segments twice — loss ratio by region AND product, say — divides the book
 * into cells, and thin cells make a real signal indistinguishable from sampling noise.
 * More policies per cell is what makes those answers worth trusting.
 *
 * Policies are spread across five years now, so ACTIVE policies at AS_AT stay in the same
 * range as before. The growth is in history, not in the size of the current book.
 */
const COUNTS = {
	customers: 14000,
	vehicles: 16800,
	policies: 22000,
	garages: 90
};

/** FR-18 glossary: claims ÷ policies. 0.30 is the calibration target. */
const BASE_CLAIM_FREQUENCY = 0.3;

const DAY_MS = 86400000;

export interface GeneratedDataset {
	regions: any[];
	customers: any[];
	vehicles: any[];
	policies: any[];
	premiumPayments: any[];
	garages: any[];
	claims: any[];
	claimPayments: any[];
	claimAssessments: any[];
}

// ─── draw helpers ────────────────────────────────────────────────────────────

function makeDraws(random: () => number) {
	const between = (min: number, max: number) => min + random() * (max - min);
	const intBetween = (min: number, max: number) => Math.floor(between(min, max + 1));

	const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];

	/** Weighted choice over [value, weight] pairs. Weights need not be normalised. */
	const weighted = (mix: Array<[string, number]>): string => {
		const total = mix.reduce((sum, [, weight]) => sum + weight, 0);
		let roll = random() * total;
		for (const [value, weight] of mix) {
			roll -= weight;
			if (roll <= 0) return value;
		}
		return mix[mix.length - 1][0];
	};

	/**
	 * Log-normal-ish positive draw. Claim severity is strongly right-skewed in reality —
	 * most claims are small, a few are very large — and a uniform draw would produce a
	 * portfolio where averages tell you everything and outlier detection (P2, Q9) has
	 * nothing to find.
	 */
	const skewed = (median: number, spread: number): number => {
		// Box–Muller from two uniforms, then exponentiate.
		const u1 = Math.max(random(), 1e-9);
		const u2 = random();
		const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
		return median * Math.exp(normal * spread);
	};

	const dateBetween = (start: Date, end: Date): Date =>
		new Date(start.getTime() + Math.floor(random() * (end.getTime() - start.getTime())));

	return {between, intBetween, pick, weighted, skewed, dateBetween};
}

const iso = (date: Date): string => date.toISOString().slice(0, 10);
const money = (value: number): string => value.toFixed(2);
const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);
const quarterOf = (date: Date): number => Math.floor(date.getUTCMonth() / 3) + 1;

// ─── signal shaping ──────────────────────────────────────────────────────────

/**
 * P3 — rainy-season peak. June–August carry ~1.8× the monthly mean claim volume.
 * Ghana's major rains run May–July with a second peak in September; concentrating the
 * excess in Jun–Aug keeps the signal legible in a monthly series (Q2 of the corpus).
 */
const SEASON_WEIGHT = [0.72, 0.7, 0.78, 0.9, 1.15, 1.85, 2.0, 1.75, 1.15, 0.85, 0.8, 0.85];

/**
 * P1 — the Northern-zone deterioration across 2025.
 *
 * The ramp is steep (1.0 → 2.85) and that is deliberate. The northern zone holds ~14%
 * of customers, which is roughly 180 claims across the four quarters of 2025 — about 45
 * a quarter. Against severity that is right-skewed by design, a gentle 1.0 → 1.7 ramp
 * disappears into sampling noise entirely; the reference implementation planted exactly
 * that and could not detect its own signal (its defect D-05).
 *
 * A planted signal nobody can detect is not a signal.
 */
const NORTHERN_2025_QUARTER_RAMP: Record<number, number> = {1: 1.0, 2: 1.62, 3: 2.18, 4: 2.85};

/**
 * Base claim severity, by product.
 *
 * This is NOT uniformly a fraction of the insured vehicle's value, and getting that
 * wrong was a real calibration defect here: third-party cover pays for the OTHER party's
 * loss, so scaling it off the insured vehicle is both actuarially backwards and
 * numerically disastrous. A third-party policy on an 80,000 GHS sedan earns ~1,000 GHS
 * of premium; charging it a 7,000 GHS expected claim made third-party business so
 * unprofitable that it consumed the entire portfolio loss-ratio budget, and the global
 * scale then dragged every other segment — including P4's — below 1.0.
 *
 * Third-party severity is therefore a flat distribution independent of the insured
 * value, which is what it is in reality.
 */
function baseSeverity(productType: string, vehicleValue: number, skewed: (median: number, spread: number) => number): number {
	if (productType === 'COMPREHENSIVE') return skewed(vehicleValue * 0.085, 0.78);
	if (productType === 'THIRD_PARTY_FIRE_THEFT') return skewed(vehicleValue * 0.05, 0.8);
	return skewed(2600, 0.72);
}

/**
 * P4 — comprehensive cover on SUV and PICKUP runs unprofitable.
 *
 * The plant has TWO parts, and using both is deliberate.
 *
 * Severity alone turned out to be a poor lever: the global scale in pass 2 normalises
 * the portfolio to TARGET_LOSS_RATIO, and this segment is a large enough share of total
 * incurred that raising its severity substantially raises the portfolio total too. The
 * scale then divides most of the increase straight back out — pushing the multiplier
 * from 1.45 to 1.9 moved the segment only from 0.68 to 0.98.
 *
 * Underpricing does not fight the scale, because it moves the DENOMINATOR. It is also
 * the more truthful story: a segment that loses money is usually one whose rate has not
 * kept up with its claims experience, which is exactly the finding an underwriting head
 * would want this system to surface (Q5).
 */
function segmentSeverityMultiplier(productType: string, category: string): number {
	if (productType === 'COMPREHENSIVE' && isHeavyCategory(category)) {
		return 1.55;
	}
	return 1.0;
}

function isHeavyCategory(category: string): boolean {
	return category === 'SUV' || category === 'PICKUP';
}

/** P5 — broker business carries ~30% higher claim frequency than direct. */
const CHANNEL_FREQUENCY_MULTIPLIER: Record<string, number> = {
	DIRECT: 0.9,
	BROKER: 1.17,
	AGENT: 1.02,
	BANCASSURANCE: 0.93
};

const CATEGORY_FREQUENCY_MULTIPLIER: Record<string, number> = {
	MOTORCYCLE: 1.35,
	SEDAN: 1.0,
	SUV: 1.05,
	PICKUP: 1.1,
	BUS: 1.25,
	TRUCK: 1.2
};

// ─── the generator ───────────────────────────────────────────────────────────

export function generateDataset(seed: number = DATASET_SEED): GeneratedDataset {
	const random = mulberry32(seed);
	const {between, intBetween, pick, weighted, skewed, dateBetween} = makeDraws(random);

	// ── regions ──────────────────────────────────────────────────────────────
	const regions = REGIONS.map((region, index) => ({
		id: index + 1,
		name: region.name,
		zone: region.zone
	}));
	const regionWeights: Array<[string, number]> = REGIONS.map((region, index) => [
		String(index + 1),
		region.weight
	]);
	const zoneOfRegion = new Map(regions.map(region => [region.id, region.zone]));

	// ── garages ──────────────────────────────────────────────────────────────
	const garages: any[] = [];
	const usedGarageNames = new Set<string>();

	// The three P2 outliers are created first so their names and ids are stable.
	OUTLIER_GARAGE_NAMES.forEach((name, index) => {
		usedGarageNames.add(name);
		garages.push({
			id: index + 1,
			name,
			region_id: intBetween(1, regions.length),
			is_approved: true,
			rating: money(between(3.4, 4.6))
		});
	});

	while (garages.length < COUNTS.garages) {
		const candidate = `${pick(GARAGE_PREFIXES).trim()} ${pick(GARAGE_SUFFIXES)}`;
		if (usedGarageNames.has(candidate)) continue;
		usedGarageNames.add(candidate);
		garages.push({
			id: garages.length + 1,
			name: candidate,
			region_id: intBetween(1, regions.length),
			is_approved: random() < 0.72,
			rating: money(between(2.1, 4.9))
		});
	}
	const outlierGarageIds = new Set(garages.slice(0, OUTLIER_GARAGE_NAMES.length).map(garage => garage.id));

	// ── customers ────────────────────────────────────────────────────────────
	// ADR-09: no name, address, phone or national identifier. customer_ref is opaque.
	const customers: any[] = [];
	for (let i = 1; i <= COUNTS.customers; i++) {
		customers.push({
			id: i,
			customer_ref: `CUS-${String(i).padStart(6, '0')}`,
			region_id: parseInt(weighted(regionWeights), 10),
			birth_year: intBetween(1955, 2004),
			gender: random() < 0.63 ? 'MALE' : 'FEMALE',
			joined_at: iso(dateBetween(new Date(Date.UTC(2018, 0, 1)), PERIOD_END)),
			segment: weighted(SEGMENT_MIX)
		});
	}

	// ── vehicles ─────────────────────────────────────────────────────────────
	const vehicles: any[] = [];
	for (let i = 1; i <= COUNTS.vehicles; i++) {
		const category = weighted(CATEGORY_MIX);
		const make = pick(CATEGORY_MAKES[category]);
		const [minValue, maxValue] = VALUE_BANDS[category];
		const [minCc, maxCc] = ENGINE_BANDS[category];
		vehicles.push({
			id: i,
			// Vehicles beyond one per customer wrap round, giving ~1.2 each.
			customer_id: ((i - 1) % COUNTS.customers) + 1,
			make,
			model: pick(VEHICLE_MAKES[make]),
			year_of_manufacture: intBetween(2005, 2024),
			category,
			engine_capacity_cc: intBetween(minCc, maxCc),
			value_ghs: money(between(minValue, maxValue))
		});
	}
	const vehicleById = new Map(vehicles.map(vehicle => [vehicle.id, vehicle]));
	const customerById = new Map(customers.map(customer => [customer.id, customer]));

	// ── policies ─────────────────────────────────────────────────────────────
	const policies: any[] = [];
	for (let i = 1; i <= COUNTS.policies; i++) {
		const vehicle = vehicleById.get(((i - 1) % COUNTS.vehicles) + 1)!;
		const productType = weighted(PRODUCT_MIX);
		const channel = weighted(CHANNEL_MIX);

		// Annual cover, starting anywhere in the period.
		const startDate = dateBetween(PERIOD_START, addDays(PERIOD_END, -30));
		const endDate = addDays(startDate, 365);

		const vehicleValue = parseFloat(vehicle.value_ghs);
		let writtenPremium: number;
		if (productType === 'COMPREHENSIVE') {
			// P4, part two: SUV and PICKUP comprehensive is written at a materially
			// thinner rate than the rest of the comprehensive book. This is the second
			// half of the plant — see segmentSeverityMultiplier for why the denominator
			// is the effective lever and the numerator is not.
			writtenPremium = isHeavyCategory(vehicle.category)
				? vehicleValue * between(0.028, 0.04)
				: vehicleValue * between(0.038, 0.056);
		} else if (productType === 'THIRD_PARTY_FIRE_THEFT') {
			writtenPremium = vehicleValue * between(0.018, 0.028);
		} else {
			// Third-party is a tariff, not a rate on value.
			writtenPremium = between(480, 1650);
		}

		/**
		 * Earned premium: the elapsed fraction of the cover period at AS_AT, pro-rata.
		 * Stored rather than computed at query time (docs §5.3, TD-B) because this is
		 * the denominator of the loss ratio and the arithmetic is the kind an LLM gets
		 * subtly wrong.
		 */
		const elapsedDays = Math.min(Math.max((AS_AT.getTime() - startDate.getTime()) / DAY_MS, 0), 365);
		const earnedPremium = writtenPremium * (elapsedDays / 365);

		let status: string;
		if (endDate > AS_AT) {
			status = random() < 0.94 ? 'ACTIVE' : 'CANCELLED';
		} else {
			const roll = random();
			status = roll < 0.86 ? 'EXPIRED' : roll < 0.95 ? 'LAPSED' : 'CANCELLED';
		}

		policies.push({
			id: i,
			policy_number: `POL-${String(i).padStart(7, '0')}`,
			customer_id: vehicle.customer_id,
			vehicle_id: vehicle.id,
			product_type: productType,
			channel,
			start_date: iso(startDate),
			end_date: iso(endDate),
			written_premium: money(writtenPremium),
			earned_premium: money(earnedPremium),
			status,
			// Not persisted — carried for the claim pass below.
			_startDate: startDate,
			_endDate: endDate,
			_category: vehicle.category,
			_zone: zoneOfRegion.get(customerById.get(vehicle.customer_id)!.region_id)!
		});
	}

	// ── premium payments ─────────────────────────────────────────────────────
	const premiumPayments: any[] = [];
	let paymentId = 1;
	for (const policy of policies) {
		// Single payment, or two to five instalments. Instalments falling after AS_AT are
		// dropped below, so the mix is chosen to land the table near its 30,000-row
		// specification after that truncation rather than before it.
		const instalments = random() < 0.28 ? 1 : intBetween(2, 5);
		const written = parseFloat(policy.written_premium);
		const perInstalment = written / instalments;
		for (let n = 0; n < instalments; n++) {
			const paymentDate = addDays(policy._startDate, n * Math.floor(365 / instalments) + intBetween(0, 6));
			if (paymentDate > AS_AT) break;
			premiumPayments.push({
				id: paymentId++,
				policy_id: policy.id,
				payment_date: iso(paymentDate),
				amount: money(perInstalment),
				method: weighted(PAYMENT_METHOD_MIX)
			});
		}
	}

	// ── claims (pass 1: relative severity) ───────────────────────────────────
	const claims: any[] = [];
	let claimId = 1;

	for (const policy of policies) {
		const frequency =
			BASE_CLAIM_FREQUENCY *
			CHANNEL_FREQUENCY_MULTIPLIER[policy.channel] *
			CATEGORY_FREQUENCY_MULTIPLIER[policy._category] *
			(policy.product_type === 'THIRD_PARTY' ? 0.82 : 1.06);

		// A policy may produce more than one claim; the second is much rarer.
		let claimCount = 0;
		if (random() < frequency) claimCount = 1;
		if (claimCount === 1 && random() < 0.09) claimCount = 2;

		for (let n = 0; n < claimCount; n++) {
			// The incident falls inside the cover period, seasonally weighted (P3).
			const incidentDate = drawSeasonalIncidentDate(policy._startDate, policy._endDate, random, SEASON_WEIGHT);
			if (!incidentDate || incidentDate > AS_AT) continue;

			const notificationDate = addDays(incidentDate, intBetween(0, 11));
			if (notificationDate > AS_AT) continue;

			const fraudFlag = random() < 0.043;

			const roll = random();
			const status = roll < 0.78 ? 'SETTLED' : roll < 0.88 ? 'OPEN' : roll < 0.96 ? 'PENDING' : 'REJECTED';

			/**
			 * P6 — fraud-flagged claims take ~2.4× the portfolio mean to settle. The
			 * investigation is the drag, so it applies to the notification→settlement
			 * leg only.
			 */
			const settlementDays = fraudFlag ? Math.round(skewed(74, 0.42)) : Math.round(skewed(29, 0.55));
			let settlementDate: Date | null = null;
			if (status === 'SETTLED') {
				const candidate = addDays(notificationDate, Math.max(settlementDays, 1));
				settlementDate = candidate > AS_AT ? null : candidate;
			}
			// A claim that would settle after AS_AT has simply not settled yet.
			const effectiveStatus = status === 'SETTLED' && settlementDate === null ? 'OPEN' : status;

			// Relative severity. Scaled globally in pass 2 — see the header note.
			const vehicle = vehicleById.get(policy.vehicle_id)!;
			let severity = baseSeverity(policy.product_type, parseFloat(vehicle.value_ghs), skewed);
			severity *= segmentSeverityMultiplier(policy.product_type, policy._category);

			// P1 — Northern-zone deterioration across the four quarters of 2025.
			if (policy._zone === 'NORTHERN' && incidentDate.getUTCFullYear() === 2025) {
				severity *= NORTHERN_2025_QUARTER_RAMP[quarterOf(incidentDate)];
			}

			claims.push({
				id: claimId,
				claim_number: `CLM-${String(claimId).padStart(7, '0')}`,
				policy_id: policy.id,
				incident_date: iso(incidentDate),
				notification_date: iso(notificationDate),
				settlement_date: settlementDate ? iso(settlementDate) : null,
				cause: weighted(CAUSE_MIX),
				status: effectiveStatus,
				fraud_flag: fraudFlag,
				_severity: severity,
				_settled: effectiveStatus === 'SETTLED'
			});
			claimId++;
		}
	}

	// ── claims (pass 2: single global scale onto the target loss ratio) ──────
	const totalEarned = policies.reduce((sum, policy) => sum + parseFloat(policy.earned_premium), 0);
	const rawIncurred = claims.reduce((sum, claim) => sum + claim._severity, 0);
	const scale = rawIncurred > 0 ? (TARGET_LOSS_RATIO * totalEarned) / rawIncurred : 1;

	for (const claim of claims) {
		const incurred = claim._severity * scale;
		// Rejected claims are reserved at zero; open and pending are part-paid.
		const paidFraction = claim.status === 'SETTLED' ? 1 : claim.status === 'REJECTED' ? 0 : between(0.15, 0.62);
		claim.incurred_amount = money(claim.status === 'REJECTED' ? incurred * 0.12 : incurred);
		claim.paid_amount = money(parseFloat(claim.incurred_amount) * paidFraction);
	}

	/**
	 * ── claim payments — the development history (FR-26) ─────────────────────
	 *
	 * This pass runs LAST and draws from its OWN generator, seeded separately.
	 *
	 * That is not fastidiousness. Every figure this project documents — loss ratio 0.752,
	 * claim frequency 0.311, severity GHS 7,312 — is reproducible only because the draw
	 * sequence is fixed. Taking numbers from the shared `random()` here would shift every
	 * subsequent draw and silently change all of them; appending a pass that consumes a
	 * different stream cannot, because the rows above are already final.
	 *
	 * ── The schedule is derived from the claim, not invented ─────────────────
	 *
	 * Payments must sum EXACTLY to `claims.paid_amount`, which pass 2 has already fixed.
	 * They are a decomposition of a number that exists, not a new quantity — so
	 * `SUM(claim_payments.amount)` equals `SUM(claims.paid_amount)` by construction, and a
	 * test asserts it. Anything else would give the product two different answers to
	 * "how much have we paid", which is precisely the drift this schema is meant to avoid.
	 *
	 *   REJECTED         nothing. Reserved at zero, paid nothing.
	 *   SETTLED          one payment at settlement, or an interim then a final. Motor is
	 *                    a short-tail line and these settle in ~35 days, so they land in
	 *                    development period 0 or, across a year boundary, 1.
	 *   OPEN / PENDING   instalments from notification up to AS_AT. These are the claims
	 *                    that are still developing, and they are what puts anything in
	 *                    development periods 1 and beyond.
	 */
	const paymentRandom = mulberry32(seed + 7919);
	const payBetween = (min: number, max: number) => min + paymentRandom() * (max - min);
	const payInt = (min: number, max: number) => Math.floor(payBetween(min, max + 1));

	const claimPayments: any[] = [];
	let claimPaymentId = 1;

	for (const claim of claims) {
		const paid = parseFloat(claim.paid_amount);
		if (!(paid > 0)) continue;

		const notified = new Date(`${claim.notification_date}T00:00:00.000Z`);
		const settled = claim.settlement_date ? new Date(`${claim.settlement_date}T00:00:00.000Z`) : null;

		/** [date, fraction of paid_amount] — fractions are normalised below. */
		const schedule: Array<[Date, number]> = [];

		if (settled) {
			// Two payments on the larger settled claims: an interim once liability is
			// admitted, the balance on settlement.
			const splits = paid > 9000 && paymentRandom() < 0.45 ? 2 : 1;
			if (splits === 1) {
				schedule.push([settled, 1]);
			} else {
				const gap = Math.max(1, Math.round((settled.getTime() - notified.getTime()) / DAY_MS));
				schedule.push([addDays(notified, Math.max(1, Math.round(gap * 0.4))), payBetween(0.3, 0.6)]);
				schedule.push([settled, 1]);
			}
		} else {
			/**
			 * Still open. Instalments across the time it has been open — more of them the
			 * longer it has run, which is what produces a genuine development tail rather
			 * than a single lump that happens to sit in a later year.
			 */
			const openDays = Math.max(1, Math.round((AS_AT.getTime() - notified.getTime()) / DAY_MS));
			const instalments = openDays > 540 ? payInt(2, 4) : openDays > 210 ? payInt(1, 3) : 1;

			for (let index = 0; index < instalments; index++) {
				// Spread across the open period, never on or after AS_AT.
				const at = Math.round((openDays * (index + 1)) / (instalments + 1));
				schedule.push([addDays(notified, Math.max(1, at)), payBetween(0.5, 1.5)]);
			}
		}

		// Normalise the weights onto `paid`, giving the LAST payment the rounding
		// remainder so the sum is exact to the cent rather than approximately right.
		const weights = schedule.map(([, weight]) => weight);
		const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

		let allocated = 0;
		schedule.forEach(([date, weight], index) => {
			const last = index === schedule.length - 1;
			const amount = last ? paid - allocated : Math.round((paid * weight * 100) / weightTotal) / 100;
			allocated += amount;

			claimPayments.push({
				id: claimPaymentId++,
				claim_id: claim.id,
				payment_date: iso(date),
				amount: money(amount),
				// FINAL only where the claim is actually closed. An open claim's newest
				// payment is still an interim, however large.
				payment_type: last && settled ? 'FINAL' : 'INTERIM'
			});
		});
	}

	// ── claim assessments ────────────────────────────────────────────────────
	const claimAssessments: any[] = [];
	let assessmentId = 1;
	for (const claim of claims) {
		// ~80% of claims reach assessment (docs §5.4).
		if (random() > 0.8) continue;

		const garageId = intBetween(1, garages.length);
		const incurred = parseFloat(claim.incurred_amount);
		const assessed = incurred * between(1.02, 1.24);

		/**
		 * P2 — three garages carry a markedly higher mean approved repair cost. Applied
		 * to the approved amount rather than the assessed one, so the signal is "these
		 * garages get paid more", which is what an outlier-detection question asks.
		 *
		 * The multiplier is ~1.95 rather than the ~1.65 the specification suggests, for
		 * the same reason P1's ramp is steep. Each garage sees only ~50 assessments, and
		 * severity is right-skewed by design, so a per-garage mean is noisy; a 1.65×
		 * plant measured as 1.39× against the all-garage mean and failed its own
		 * verification. The comparison also dilutes itself — the three outliers are
		 * inside the national mean they are being compared against.
		 */
		const outlierMultiplier = outlierGarageIds.has(garageId) ? between(1.85, 2.05) : between(0.94, 1.06);
		const approved = assessed * outlierMultiplier * between(0.86, 0.99);

		claimAssessments.push({
			id: assessmentId++,
			claim_id: claim.id,
			garage_id: garageId,
			assessment_date: iso(addDays(new Date(`${claim.notification_date}T00:00:00Z`), intBetween(1, 21))),
			assessed_amount: money(assessed),
			approved_amount: money(approved),
			labour_hours: money(between(2, 68))
		});
	}

	// Strip the carrier fields so what is returned is exactly what the tables hold.
	const strip = (rows: any[], keys: string[]) =>
		rows.map(row => {
			const copy = {...row};
			for (const key of keys) delete copy[key];
			return copy;
		});

	return {
		regions,
		customers,
		vehicles,
		policies: strip(policies, ['_startDate', '_endDate', '_category', '_zone']),
		premiumPayments,
		garages,
		claims: strip(claims, ['_severity', '_settled']),
		claimPayments,
		claimAssessments
	};
}

/**
 * Draw an incident date inside the cover period, weighted by month (P3).
 *
 * Rejection sampling against the seasonal weights: draw a uniform date, accept it with
 * probability proportional to its month's weight. Bounded at 24 attempts so a policy
 * whose cover period falls entirely in low-season months cannot spin.
 */
function drawSeasonalIncidentDate(
	start: Date,
	end: Date,
	random: () => number,
	weights: number[]
): Date | null {
	const maxWeight = Math.max(...weights);
	const span = end.getTime() - start.getTime();
	if (span <= 0) return null;

	for (let attempt = 0; attempt < 24; attempt++) {
		const candidate = new Date(start.getTime() + Math.floor(random() * span));
		if (random() < weights[candidate.getUTCMonth()] / maxWeight) {
			return candidate;
		}
	}
	return new Date(start.getTime() + Math.floor(random() * span));
}
