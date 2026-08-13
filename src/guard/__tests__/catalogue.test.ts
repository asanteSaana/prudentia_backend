import {ANALYTICS_TABLE_ORDER, APPLICATION_TABLE_LIST} from '../../_services/_dbTables';
import {ALLOWED_COLUMNS, ALLOWED_TABLES, CATALOGUE, columnsOf, METRIC_GLOSSARY, renderSchemaForLlm} from '../catalogue';

/**
 * The catalogue is ONE source with TWO consumers (CLAUDE.md §4 rule 6): what the LLM is
 * told exists, and what the gate permits. These tests assert the two cannot diverge.
 *
 * Divergence is insidious in both directions. A table the model is told about but the
 * gate refuses produces questions rejected for a reason nobody can see. A table the gate
 * permits but the model is never told about is an unreviewed hole in the whitelist that
 * no test would otherwise notice.
 */

describe('catalogue and gate whitelist cannot diverge', () => {
	it('every table the LLM is shown is a table the gate permits', () => {
		const rendered = renderSchemaForLlm();
		for (const table of CATALOGUE) {
			expect(rendered).toContain(table.name);
			expect(ALLOWED_TABLES.has(table.name)).toBe(true);
		}
	});

	it('every table the gate permits is a table the LLM is shown', () => {
		const rendered = renderSchemaForLlm();
		for (const table of ALLOWED_TABLES) {
			expect(rendered).toContain(table);
		}
	});

	it('every column the LLM is shown is a column the gate permits', () => {
		const rendered = renderSchemaForLlm();
		for (const table of CATALOGUE) {
			for (const column of table.columns) {
				expect(rendered).toContain(column.name);
				expect(ALLOWED_COLUMNS.has(column.name)).toBe(true);
			}
		}
	});

	it('matches the analytics tables the read-only role is granted', () => {
		// The third leg: catalogue, LLM context, and the GRANT list in the migration.
		// If these three ever disagree, one of them is lying about the boundary.
		expect([...ALLOWED_TABLES].sort()).toEqual([...ANALYTICS_TABLE_ORDER].sort());
	});
});

describe('application tables are absent from the catalogue', () => {
	it.each(APPLICATION_TABLE_LIST)('%s is not in the whitelist', table => {
		expect(ALLOWED_TABLES.has(table)).toBe(false);
	});

	it.each(APPLICATION_TABLE_LIST)('%s is not described to the LLM', table => {
		// The model is never even told these exist. TH-02 fails at the table check
		// regardless of whether it was persuaded to try.
		const rendered = renderSchemaForLlm();
		expect(rendered).not.toContain(`  ${table} —`);
	});

	it('does not expose password_hash as a known column', () => {
		expect(ALLOWED_COLUMNS.has('password_hash')).toBe(false);
	});
});

describe('metric glossary', () => {
	it('defines every term the acceptance corpus depends on', () => {
		const terms = METRIC_GLOSSARY.map(entry => entry.term.toLowerCase());
		for (const required of ['loss ratio', 'claim frequency', 'claim severity', 'earned premium', 'settlement cycle time']) {
			expect(terms).toContain(required);
		}
	});

	it('is included in what the LLM is shown', () => {
		const rendered = renderSchemaForLlm();
		expect(rendered).toContain('METRIC DEFINITIONS');
		expect(rendered).toContain('earned_premium');
	});

	it('pins loss ratio to earned premium, not written premium', () => {
		// The single most consequential definition in the product. Getting this wrong
		// produces a plausible number that is quietly wrong — risk R-01.
		const lossRatio = METRIC_GLOSSARY.find(entry => entry.term === 'Loss ratio')!;
		expect(lossRatio.definition).toContain('earned_premium');
		expect(lossRatio.definition).toContain('Never written_premium');
	});
});

describe('catalogue shape', () => {
	it('describes all 8 analytics tables', () => {
		expect(CATALOGUE).toHaveLength(8);
	});

	it('gives every column a type and a description', () => {
		for (const table of CATALOGUE) {
			expect(table.columns.length).toBeGreaterThan(0);
			for (const column of table.columns) {
				expect(column.type).toBeTruthy();
				expect(column.description).toBeTruthy();
			}
		}
	});

	it('resolves columns for a named table', () => {
		expect(columnsOf('claims')).toContain('incurred_amount');
		expect(columnsOf('nope')).toEqual([]);
	});

	it('sends no table contents to the LLM — structure and glossary only', () => {
		// ADR-06. A sample row would export commercially sensitive data to a third-party
		// processor; accuracy is bought with the glossary instead.
		const rendered = renderSchemaForLlm();
		expect(rendered).not.toMatch(/CUS-\d/);
		expect(rendered).not.toMatch(/POL-\d/);
		expect(rendered).not.toMatch(/CLM-\d/);
	});
});
