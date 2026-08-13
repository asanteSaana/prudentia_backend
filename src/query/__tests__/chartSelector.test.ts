import {ExecutionResult} from '../../guard/executor';
import {selectChartType} from '../chartSelector';

/**
 * ADR-08 — the model's chart recommendation is untrusted and reconciled against the
 * actual result shape. Cases F-17 to F-20 plus the boundaries either side of them.
 */

const result = (
	columns: Array<[string, string]>,
	rowCount: number
): ExecutionResult => ({
	columns: columns.map(([name, type]) => ({name, type})),
	rows: Array.from({length: rowCount}, () => columns.map(() => 0)),
	rowCount,
	durationMs: 1,
	truncated: false
});

describe('shape overrides the hint', () => {
	it('F-17 a single scalar is a KPI even when the model asked for a line', () => {
		expect(selectChartType('line', result([['loss_ratio', 'numeric']], 1))).toBe('kpi');
	});

	it('F-17b a single scalar is a KPI even when the model asked for a table', () => {
		expect(selectChartType('table', result([['loss_ratio', 'numeric']], 1))).toBe('kpi');
	});

	it('F-18 a line hint over categorical data is downgraded to a bar', () => {
		// A line asserts the x-axis is ordered and the gaps mean something. Over
		// categories neither holds, and joining them draws a trend that does not exist.
		expect(selectChartType('line', result([['region', 'text'], ['n', 'numeric']], 10))).toBe('bar');
	});

	it('F-19 a kpi hint over many rows is upgraded to a bar', () => {
		// The model expected one number and got a distribution. Rendering the first row as
		// the answer would be a silent, confident lie.
		expect(selectChartType('kpi', result([['category', 'text'], ['n', 'numeric']], 6))).toBe('bar');
	});

	it('F-20 three or more columns is forced to a table', () => {
		// A chart of three columns must drop one, and dropping data to fit a chart type is
		// how a chart starts lying.
		expect(
			selectChartType('bar', result([['a', 'text'], ['b', 'numeric'], ['c', 'numeric']], 5))
		).toBe('table');
	});
});

describe('temporal detection', () => {
	it('keeps a line for a temporal label column', () => {
		expect(selectChartType('line', result([['month', 'timestamp'], ['n', 'numeric']], 12))).toBe('line');
	});

	it('detects a temporal column by name when the driver reports text', () => {
		expect(selectChartType('line', result([['incident_month', 'text'], ['n', 'numeric']], 12))).toBe('line');
	});

	it('upgrades a bar hint over temporal data to a line', () => {
		// The ordering carries real meaning here, so a line is the more honest rendering.
		expect(selectChartType('bar', result([['month', 'date'], ['n', 'numeric']], 12))).toBe('line');
	});

	it('does not treat an arbitrary text column as temporal', () => {
		expect(selectChartType('bar', result([['make', 'text'], ['n', 'numeric']], 8))).toBe('bar');
	});
});

describe('degenerate shapes', () => {
	it('an empty result is a table, not an empty chart', () => {
		expect(selectChartType('bar', result([['region', 'text'], ['n', 'numeric']], 0))).toBe('table');
	});

	it('a result with no columns is a table', () => {
		expect(selectChartType('kpi', result([], 0))).toBe('table');
	});

	it('one column with many rows is a table, not a chart with no labels', () => {
		expect(selectChartType('bar', result([['policy_number', 'text']], 40))).toBe('table');
	});

	it('an explicit table request over two columns is respected', () => {
		expect(selectChartType('table', result([['region', 'text'], ['n', 'numeric']], 10))).toBe('table');
	});
});
