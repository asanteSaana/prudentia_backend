import {ExecutionResult} from '../../guard/executor';
import {selectChart} from '../chartSelector';

/**
 * ADR-08 — the model's chart recommendation is untrusted and reconciled against the
 * actual result shape. Cases F-17 to F-20 plus the boundaries either side of them, and
 * the rules governing the extended vocabulary (`hbar`, `area`, `donut`).
 *
 * `selectChart` now returns the legitimate ALTERNATIVES as well as the first choice,
 * because the interface's toggle needs that list and deriving it a second time in the
 * client would be two implementations of "is this honest?" — with the divergent one on
 * the untrusted side of the wire. So the options are asserted here too.
 */

const result = (columns: Array<[string, string]>, rows: unknown[][]): ExecutionResult => ({
	columns: columns.map(([name, type]) => ({name, type})),
	rows,
	rowCount: rows.length,
	durationMs: 1,
	truncated: false
});

/** N rows of [shortLabel, 1]. */
const rowsOf = (count: number, label = 'x'): unknown[][] =>
	Array.from({length: count}, (_, index) => [`${label}${index}`, 1]);

const pick = (hint: Parameters<typeof selectChart>[0], data: ExecutionResult) => selectChart(hint, data).chartType;
const options = (hint: Parameters<typeof selectChart>[0], data: ExecutionResult) => selectChart(hint, data).options;

const CATEGORY = [['region', 'text'], ['n', 'numeric']] as Array<[string, string]>;
const TEMPORAL = [['month', 'date'], ['n', 'numeric']] as Array<[string, string]>;

describe('shape overrides the hint', () => {
	it('F-17 a single scalar is a KPI even when the model asked for a line', () => {
		expect(pick('line', result([['loss_ratio', 'numeric']], [[0.75]]))).toBe('kpi');
	});

	it('F-17b a single scalar is a KPI even when the model asked for a table', () => {
		expect(pick('table', result([['loss_ratio', 'numeric']], [[0.75]]))).toBe('kpi');
	});

	it('F-18 a line hint over categorical data is downgraded to a bar', () => {
		// A line asserts the x-axis is ordered and the gaps mean something. Over
		// categories neither holds, and joining them draws a trend that does not exist.
		expect(pick('line', result(CATEGORY, rowsOf(6)))).toBe('bar');
	});

	it('F-18b a line is not even OFFERED over categorical data', () => {
		// The stronger form of F-18: it must not be reachable through the toggle either,
		// or the client hands back the dishonest chart the server just refused.
		expect(options('line', result(CATEGORY, rowsOf(6)))).not.toContain('line');
		expect(options('line', result(CATEGORY, rowsOf(6)))).not.toContain('area');
	});

	it('F-19 a kpi hint over many rows is upgraded to a bar', () => {
		// The model expected one number and got a distribution. Rendering the first row as
		// the answer would be a silent, confident lie.
		expect(pick('kpi', result(CATEGORY, rowsOf(6)))).toBe('bar');
	});

	it('F-20 three or more columns is forced to a table, with no alternatives', () => {
		// A chart of three columns must drop one, and dropping data to fit a chart type is
		// how a chart starts lying.
		const wide = result(
			[['a', 'text'], ['b', 'numeric'], ['c', 'numeric']],
			[['x', 1, 2]]
		);
		expect(pick('bar', wide)).toBe('table');
		expect(options('bar', wide)).toEqual(['table']);
	});
});

describe('temporal detection', () => {
	it('keeps a line for a temporal label column', () => {
		expect(pick('line', result([['month', 'timestamp'], ['n', 'numeric']], rowsOf(12)))).toBe('line');
	});

	it('detects a temporal column by name when the driver reports text', () => {
		expect(pick('line', result([['incident_month', 'text'], ['n', 'numeric']], rowsOf(12)))).toBe('line');
	});

	it('honours an area hint over temporal data', () => {
		expect(pick('area', result(TEMPORAL, rowsOf(12)))).toBe('area');
	});

	it('an area hint over CATEGORIES is refused, exactly like a line', () => {
		// Area is a line with a fill. It makes the same false claim about ordering.
		expect(pick('area', result(CATEGORY, rowsOf(6)))).toBe('bar');
	});

	it('keeps a bar over a small number of periods, because comparison beats trend there', () => {
		expect(pick('bar', result(TEMPORAL, rowsOf(4)))).toBe('bar');
	});

	it('upgrades a bar hint over MANY periods to a line', () => {
		expect(pick('bar', result(TEMPORAL, rowsOf(36)))).toBe('line');
	});

	it('does not treat an arbitrary text column as temporal', () => {
		expect(pick('bar', result([['make', 'text'], ['n', 'numeric']], rowsOf(8)))).toBe('bar');
	});

	/**
	 * A donut of months would slice a sequence into parts of a whole. Time is not a
	 * composition; a year is not made of its months in the way a portfolio is made of its
	 * channels.
	 */
	it('never offers a donut over a time series', () => {
		expect(options('donut', result(TEMPORAL, rowsOf(12)))).not.toContain('donut');
		expect(pick('donut', result(TEMPORAL, rowsOf(12)))).toBe('line');
	});
});

describe('the donut is offered only where parts really sum to a whole', () => {
	it('offers it for an additive measure over few categories', () => {
		const data = result([['channel', 'text'], ['total_premium', 'numeric']], rowsOf(4, 'ch'));
		expect(options('donut', data)).toContain('donut');
		expect(pick('donut', data)).toBe('donut');
	});

	/**
	 * THE rule worth having. Six regions' loss ratios do not add up to anything: the sum
	 * is meaningless, so a circle divided into those proportions asserts something false.
	 * The measure is detected by column NAME, which is a heuristic — but it is a
	 * presentation heuristic whose worst outcome is a bar chart, and it never touches SQL.
	 */
	it.each([['loss_ratio'], ['avg_severity'], ['claim_rate'], ['pct_settled'], ['average_days'], ['rating']])(
		'refuses it for a non-additive measure: %s',
		column => {
			const data = result([['region', 'text'], [column, 'numeric']], rowsOf(5));
			expect(options('donut', data)).not.toContain('donut');
			expect(pick('donut', data)).not.toBe('donut');
		}
	);

	it('refuses it when any value is negative, because a slice cannot be', () => {
		const data = result(
			[['region', 'text'], ['underwriting_profit', 'numeric']],
			[['A', 100], ['B', -40], ['C', 25]]
		);
		expect(options('donut', data)).not.toContain('donut');
	});

	it('refuses it beyond eight slices, where angles stop being comparable', () => {
		expect(options('donut', result([['make', 'text'], ['n', 'numeric']], rowsOf(8)))).toContain('donut');
		expect(options('donut', result([['make', 'text'], ['n', 'numeric']], rowsOf(9)))).not.toContain('donut');
	});
});

describe('horizontal bars where labels need the room', () => {
	it('prefers hbar when a label is long', () => {
		const data = result(
			[['garage', 'text'], ['total_repair_cost', 'numeric']],
			[['Kwame Auto Services Limited', 10], ['Accra Panel Beaters', 8]]
		);
		expect(pick('bar', data)).toBe('hbar');
	});

	it('prefers hbar when there are many categories', () => {
		expect(pick('bar', result([['make', 'text'], ['n', 'numeric']], rowsOf(11)))).toBe('hbar');
	});

	it('keeps the vertical bar for a few short labels', () => {
		expect(pick('bar', result([['zone', 'text'], ['n', 'numeric']], rowsOf(3)))).toBe('bar');
	});

	it('always offers both orientations for categories — they encode identically', () => {
		const opts = options('bar', result(CATEGORY, rowsOf(5)));
		expect(opts).toContain('bar');
		expect(opts).toContain('hbar');
	});
});

describe('degenerate shapes', () => {
	it('an empty result is a table, not an empty chart', () => {
		expect(pick('bar', result(CATEGORY, []))).toBe('table');
	});

	it('a result with no columns is a table', () => {
		expect(pick('kpi', result([], []))).toBe('table');
	});

	it('one column with many rows is a table, not a chart with no labels', () => {
		expect(pick('bar', result([['policy_number', 'text']], Array.from({length: 40}, () => ['P'])))).toBe('table');
	});

	it('an explicit table request over two columns is respected', () => {
		expect(pick('table', result(CATEGORY, rowsOf(10)))).toBe('table');
	});
});

describe('the first choice is always among the offered options', () => {
	/**
	 * The invariant the client depends on: it renders `chartType` and draws a toggle from
	 * `options`, so a first choice absent from its own list would show a chart the toggle
	 * cannot return to.
	 */
	const shapes: Array<[string, ExecutionResult]> = [
		['scalar', result([['n', 'numeric']], [[1]])],
		['categories', result(CATEGORY, rowsOf(5))],
		['many categories', result(CATEGORY, rowsOf(30))],
		['time series', result(TEMPORAL, rowsOf(24))],
		['additive categories', result([['channel', 'text'], ['premium', 'numeric']], rowsOf(4))],
		['three columns', result([['a', 'text'], ['b', 'numeric'], ['c', 'numeric']], [['x', 1, 2]])],
		['empty', result(CATEGORY, [])]
	];

	const hints = ['kpi', 'bar', 'hbar', 'line', 'area', 'donut', 'table'] as const;

	it.each(shapes)('%s', (_name, data) => {
		for (const hint of hints) {
			const decision = selectChart(hint, data);
			expect(decision.options).toContain(decision.chartType);
		}
	});
});
