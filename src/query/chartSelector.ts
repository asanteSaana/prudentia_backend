import {ExecutionResult} from '../guard/executor';
import {ChartType} from '../_typings/types';

/**
 * Stage 6: reconcile the model's chart recommendation against the ACTUAL result (ADR-08).
 *
 * The model recommends a chart before it has seen a single row — it is guessing from the
 * SQL it just wrote. That guess is untrusted like every other thing it produces, and a
 * recommendation inconsistent with the returned shape produces a broken interface: a
 * line chart of one number, a bar chart of a thousand categories.
 *
 * So the shape decides, and the hint only breaks ties. This is a small deterministic
 * function precisely so it can be reasoned about and tested exhaustively — the
 * reconciliation is not a heuristic that "usually works", it is a total function over
 * result shapes.
 */

/** Names that indicate a temporal axis, so `line` is legitimate. */
const TEMPORAL_HINTS = ['month', 'date', 'day', 'week', 'quarter', 'year', 'period', 'time'];

function looksTemporal(columnName: string, columnType: string): boolean {
	if (columnType === 'date' || columnType === 'timestamp') return true;
	const name = columnName.toLowerCase();
	return TEMPORAL_HINTS.some(hint => name.includes(hint));
}

/**
 * @param hint  What the model recommended. Untrusted.
 * @param result The shape that actually came back. Authoritative.
 */
export function selectChartType(hint: ChartType, result: ExecutionResult): ChartType {
	const {columns, rows} = result;

	// Nothing to draw. The interface renders an empty state, not a chart.
	if (rows.length === 0 || columns.length === 0) return 'table';

	/**
	 * A single scalar is ALWAYS a KPI, whatever the model asked for. One row, one column
	 * is one number; there is no chart of one number that is not worse than the number.
	 * (Test F-17.)
	 */
	if (rows.length === 1 && columns.length === 1) return 'kpi';

	/**
	 * Three or more columns is a table, whatever the model asked for. A bar or line chart
	 * of three columns has to silently drop one, and dropping data to satisfy a chart
	 * type is how a chart starts lying. (Test F-20.)
	 */
	if (columns.length >= 3) return 'table';

	// From here: exactly two columns, or one column with several rows.
	if (columns.length === 1) return 'table';

	const [labelColumn] = columns;
	const temporal = looksTemporal(labelColumn.name, labelColumn.type);

	/**
	 * A `line` hint over non-temporal data becomes a bar. A line chart asserts that the
	 * x-axis has an order and that the space between points means something; over
	 * categories neither is true, and connecting them draws a trend that does not exist.
	 * (Test F-18.)
	 */
	if (hint === 'line') return temporal ? 'line' : 'bar';

	/**
	 * A `kpi` hint over several rows becomes a bar — the model expected one number and
	 * got a distribution. Showing the first row as though it were the answer would be a
	 * silent, confident lie. (Test F-19.)
	 */
	if (hint === 'kpi') return temporal ? 'line' : 'bar';

	// `table` is always honest, so an explicit request for it is respected.
	if (hint === 'table') return 'table';

	// `bar` over temporal data is upgraded: the ordering carries real meaning.
	return temporal ? 'line' : 'bar';
}
