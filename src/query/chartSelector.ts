import {ExecutionResult} from '../guard/executor';
import {ChartType} from '../_typings/types';

/**
 * Stage 6: reconcile the model's chart recommendation against the ACTUAL result (ADR-08).
 *
 * The model recommends a chart before it has seen a single row — it is guessing from the
 * SQL it just wrote. That guess is untrusted like every other thing it produces, and a
 * recommendation inconsistent with the returned shape produces a broken interface: a line
 * chart of one number, a donut of a thousand categories.
 *
 * So the shape decides, and the hint only breaks ties. This is a small deterministic
 * function precisely so it can be reasoned about and tested exhaustively — the
 * reconciliation is not a heuristic that "usually works", it is a total function over
 * result shapes.
 *
 * ── It now returns the ALTERNATIVES too, and that is the point ────────────────
 *
 * The interface offers a toggle between presentations of the same answer, so something
 * has to decide which alternatives are legitimate. That used to be decided twice — once
 * here and once again in the client's `allowedViews` — which is the same
 * two-sources-of-truth mistake the schema catalogue exists to avoid (CLAUDE.md §4 rule 6).
 * Two implementations of "is a donut honest for this data?" will diverge, and the one that
 * diverges is the client, which is the untrusted side of the wire.
 *
 * So the decision is made once, here, over the real rows, and the client renders the list
 * it is given.
 */

/** Names that indicate a temporal axis, so `line` and `area` are legitimate. */
const TEMPORAL_HINTS = ['month', 'date', 'day', 'week', 'quarter', 'year', 'period', 'time'];

/**
 * Names indicating a NON-ADDITIVE measure — an average, ratio, rate or score.
 *
 * This decides one thing only: whether a **donut** may be offered. Slices of a donut
 * assert that the parts sum to a meaningful whole, which is true of premium and claim
 * counts and false of loss ratios and mean severities — adding six regions' loss ratios
 * produces a number that means nothing, and drawing it as a circle says otherwise.
 *
 * It is a heuristic over a COLUMN NAME, and it is used for PRESENTATION ONLY. It never
 * touches SQL, never affects what executes, and its worst failure is offering a bar chart
 * where a donut would also have been defensible. That is the whole reason a name test is
 * acceptable here and nowhere near the gate.
 */
const NON_ADDITIVE_HINTS = ['avg', 'average', 'mean', 'median', 'ratio', 'rate', 'percent', 'pct', 'per_', 'score', 'rating'];

/** Beyond this, angles stop being comparable and a donut is decoration. */
const MAX_DONUT_SLICES = 8;

/** Long labels read far better on a horizontal axis — garage and region names especially. */
const LONG_LABEL_CHARS = 14;

export interface ChartDecision {
	/** What to show first. */
	chartType: ChartType;
	/**
	 * Every presentation that is HONEST for this result, `chartType` included.
	 * Never all of them — a donut of a time series is not on this list.
	 */
	options: ChartType[];
}

function looksTemporal(columnName: string, columnType: string): boolean {
	if (columnType === 'date' || columnType === 'timestamp') return true;
	const name = columnName.toLowerCase();
	return TEMPORAL_HINTS.some(hint => name.includes(hint));
}

function looksAdditive(columnName: string): boolean {
	const name = columnName.toLowerCase();
	return !NON_ADDITIVE_HINTS.some(hint => name.includes(hint));
}

/**
 * @param hint   What the model recommended. Untrusted.
 * @param result The shape that actually came back. Authoritative.
 */
export function selectChart(hint: ChartType, result: ExecutionResult): ChartDecision {
	const {columns, rows} = result;

	// Nothing to draw. The interface renders an empty state, not a chart.
	if (rows.length === 0 || columns.length === 0) return {chartType: 'table', options: ['table']};

	/**
	 * A single scalar is ALWAYS a KPI, whatever the model asked for. One row, one column
	 * is one number; there is no chart of one number that is not worse than the number.
	 * (Test F-17.)
	 */
	if (rows.length === 1 && columns.length === 1) return {chartType: 'kpi', options: ['kpi', 'table']};

	/**
	 * Three or more columns is a table, whatever the model asked for. A bar or line chart
	 * of three columns has to silently drop one, and dropping data to satisfy a chart
	 * type is how a chart starts lying. (Test F-20.)
	 */
	if (columns.length >= 3) return {chartType: 'table', options: ['table']};

	// From here: exactly two columns, or one column with several rows.
	if (columns.length === 1) return {chartType: 'table', options: ['table']};

	const [labelColumn, valueColumn] = columns;
	const temporal = looksTemporal(labelColumn.name, labelColumn.type);

	if (temporal) {
		/**
		 * Time series. `line` and `area` both assert an ordered x-axis, which is true here;
		 * `bar` is legitimate for a small number of periods. A DONUT IS NOT OFFERED — parts
		 * of a whole is not what a sequence of months is, and slicing a year into months
		 * answers a question nobody asked.
		 */
		const options: ChartType[] = ['line', 'area', 'bar', 'table'];
		// `table` is always honest, so an explicit request for it is respected.
		if (hint === 'table') return {chartType: 'table', options};
		if (hint === 'area') return {chartType: 'area', options};
		if (hint === 'bar' && rows.length <= 12) return {chartType: 'bar', options};
		/**
		 * `bar` over many periods, and `kpi` over several rows, both become the line: the
		 * model expected one shape and got another, and showing the first row as though it
		 * were the answer would be a silent, confident lie. (Tests F-18, F-19.)
		 */
		return {chartType: 'line', options};
	}

	/**
	 * Categories. A LINE IS NEVER OFFERED: it asserts that the x-axis has an order and
	 * that the space between points means something, and over categories neither is true.
	 * Connecting them draws a trend that does not exist. (Test F-18.)
	 */
	const options: ChartType[] = ['bar', 'hbar', 'table'];

	// A donut needs parts that sum to a whole: additive, non-negative, and few enough
	// that the eye can still compare angles.
	const additive = looksAdditive(valueColumn.name);
	const allNonNegative = rows.every(row => {
		const value = row[1];
		return typeof value !== 'number' || value >= 0;
	});
	if (additive && allNonNegative && rows.length <= MAX_DONUT_SLICES) options.splice(2, 0, 'donut');

	if (hint === 'table') return {chartType: 'table', options};
	if (hint === 'donut' && options.includes('donut')) return {chartType: 'donut', options};

	/**
	 * Long labels or many of them default to the HORIZONTAL bar, because the alternative
	 * is rotated text nobody reads. This is a readability default, not a restriction —
	 * `bar` stays one click away.
	 */
	const longestLabel = rows.reduce((longest, row) => Math.max(longest, String(row[0] ?? '').length), 0);
	if (hint === 'hbar' || longestLabel > LONG_LABEL_CHARS || rows.length > 10) {
		return {chartType: 'hbar', options};
	}

	return {chartType: 'bar', options};
}
