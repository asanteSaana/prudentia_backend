/**
 * Table-name constants. Referencing a table by symbol rather than by string is the
 * template convention and it means a rename is a compile error rather than a runtime
 * one.
 *
 * The split below is not cosmetic. `Analytics` is exactly the set of tables the
 * SELECT-only role may read and the schema catalogue advertises to the LLM;
 * `Application` is the set it holds no privilege on at all. Keeping them in separate
 * objects makes "is this table exposed to generated SQL?" answerable by looking at
 * one line.
 *
 * CLAUDE.md §4 rules 5 and 6. Adding a table here is not enough to expose it — the
 * catalogue (src/guard/catalogue.ts) is the single source of truth for that, and the
 * grant is written by hand, one statement per table, in a migration.
 */

export const AnalyticsTables = {
	Regions: 'regions',
	Customers: 'customers',
	Vehicles: 'vehicles',
	Policies: 'policies',
	PremiumPayments: 'premium_payments',
	Garages: 'garages',
	Claims: 'claims',
	ClaimAssessments: 'claim_assessments'
} as const;

export const ApplicationTables = {
	Users: 'users',
	QueryLog: 'query_log'
} as const;

export const DB = {...AnalyticsTables, ...ApplicationTables} as const;

/** The 8 analytics tables, in dependency order — safe for create; reverse for drop. */
export const ANALYTICS_TABLE_ORDER: string[] = [
	AnalyticsTables.Regions,
	AnalyticsTables.Customers,
	AnalyticsTables.Vehicles,
	AnalyticsTables.Policies,
	AnalyticsTables.PremiumPayments,
	AnalyticsTables.Garages,
	AnalyticsTables.Claims,
	AnalyticsTables.ClaimAssessments
];

/** Never granted to the read-only role. A user must not be able to read a hash. */
export const APPLICATION_TABLE_LIST: string[] = [ApplicationTables.Users, ApplicationTables.QueryLog];
