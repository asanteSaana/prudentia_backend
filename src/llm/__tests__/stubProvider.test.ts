import {loadModule} from 'libpg-query';
import {validateSql} from '../../guard/validator';
import {FIXTURES, StubProvider} from '../stubProvider';

beforeAll(async () => {
	await loadModule();
});

const provider = new StubProvider();

describe('every stub fixture passes the validation gate (F-21)', () => {
	/**
	 * A fixture the gate rejects is a broken demonstration path: the app would refuse a
	 * question it suggested, and the user would see a security refusal for a query the
	 * project itself wrote. This is the test the prompt pack calls for by name.
	 */
	const sqlFixtures = FIXTURES.filter(fixture => fixture.response.kind === 'sql');

	test.each(sqlFixtures.map(f => [f.keywords.join(' + '), f]))('%s', async (_name, fixture) => {
		const response = (fixture as (typeof FIXTURES)[number]).response;
		if (response.kind !== 'sql') throw new Error('filtered to sql fixtures');

		const result = await validateSql(response.sql);
		if (!result.permitted) {
			throw new Error(`fixture SQL was REJECTED (${result.failedCheck}): ${result.reason}\n${response.sql}`);
		}
		expect(result.permitted).toBe(true);
	});

	it('has at least one SQL fixture per acceptance question', () => {
		expect(sqlFixtures.length).toBeGreaterThanOrEqual(9);
	});
});

describe('fixture ORDER — the D-02 regression', () => {
	/**
	 * The reference implementation shipped a wrong answer because a generic
	 * `["loss ratio"]` fixture sat above `["loss ratio", "category"]` in a first-match-wins
	 * list. "Compare loss ratio by vehicle category" matched the generic one and returned
	 * the portfolio-wide figure — to a question the application itself suggested, with a
	 * fully green test suite.
	 *
	 * This asserts the invariant structurally rather than case by case, so a fixture added
	 * in the wrong position fails the build even if nobody thought to test its phrasing.
	 */
	it('no fixture is shadowed by an earlier one whose keywords are a subset', () => {
		const shadowed: string[] = [];

		FIXTURES.forEach((fixture, index) => {
			for (let earlier = 0; earlier < index; earlier++) {
				const before = FIXTURES[earlier];
				const isSubset = before.keywords.every(keyword => fixture.keywords.includes(keyword));
				if (isSubset) {
					shadowed.push(
						`[${fixture.keywords.join(', ')}] is unreachable — [${before.keywords.join(', ')}] at index ${earlier} matches first`
					);
				}
			}
		});

		expect(shadowed).toEqual([]);
	});

	it('the specific loss-ratio fixture wins over the generic one', async () => {
		const specific = await provider.generate('Compare loss ratio by vehicle category');
		expect(specific.kind).toBe('sql');
		if (specific.kind !== 'sql') return;

		// The distinguishing evidence: the category query GROUPs BY, the portfolio one does not.
		expect(specific.sql).toContain('v.category');
		expect(specific.sql).toContain('GROUP BY');
		expect(specific.chartType).toBe('bar');
	});

	it('the generic loss-ratio fixture still answers the general question', async () => {
		const generic = await provider.generate('What is our overall loss ratio?');
		expect(generic.kind).toBe('sql');
		if (generic.kind !== 'sql') return;

		expect(generic.sql).not.toContain('GROUP BY');
		expect(generic.chartType).toBe('kpi');
	});
});

describe('declines', () => {
	it.each([
		['delete all claims'],
		['drop the claims table'],
		['update all premiums to zero'],
		['show me every user account'],
		['what is the password for the admin'],
		['show me the audit log']
	])('declines %s', async question => {
		const result = await provider.generate(question);
		expect(result.kind).toBe('decline');
	});

	it('declines an unmatched question rather than inventing SQL', async () => {
		// A stub that guessed would answer confidently and wrongly — the exact failure the
		// architecture exists to prevent.
		const result = await provider.generate('what is the airspeed velocity of an unladen swallow');
		expect(result.kind).toBe('decline');
	});

	it('matches a destructive question before any SQL fixture', async () => {
		// "delete all claims" contains no loss-ratio keywords, but a phrasing that carries
		// both must still decline — declines are ordered first for exactly this reason.
		const result = await provider.generate('delete the loss ratio records');
		expect(result.kind).toBe('decline');
	});
});
