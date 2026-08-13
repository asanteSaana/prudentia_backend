/**
 * Enumerated column values.
 *
 * These are the single source for three things that must not drift: the CHECK
 * constraints in the migrations, the generator's draws, and the value lists the schema
 * catalogue shows the LLM. A value the model is told exists but the constraint forbids
 * produces a query that validates and then fails at execution — the confusing failure
 * CLAUDE.md §4 rule 6 is written to prevent.
 *
 * Stored as varchar with a CHECK rather than a Postgres enum type, following the
 * template estate: adding a value is then a constraint change, not a type migration.
 */

export const Zones = ['NORTHERN', 'MIDDLE', 'COASTAL'] as const;

export const Genders = ['MALE', 'FEMALE'] as const;

export const CustomerSegments = ['RETAIL', 'SME', 'CORPORATE', 'FLEET'] as const;

export const VehicleCategories = ['SEDAN', 'SUV', 'PICKUP', 'MOTORCYCLE', 'BUS', 'TRUCK'] as const;

export const ProductTypes = ['COMPREHENSIVE', 'THIRD_PARTY', 'THIRD_PARTY_FIRE_THEFT'] as const;

export const Channels = ['DIRECT', 'BROKER', 'AGENT', 'BANCASSURANCE'] as const;

export const PolicyStatuses = ['ACTIVE', 'EXPIRED', 'CANCELLED', 'LAPSED'] as const;

export const PaymentMethods = ['MOBILE_MONEY', 'BANK_TRANSFER', 'CARD', 'CASH', 'CHEQUE'] as const;

export const ClaimCauses = ['ACCIDENT', 'THEFT', 'FIRE', 'FLOOD', 'VANDALISM', 'THIRD_PARTY'] as const;

export const ClaimStatuses = ['SETTLED', 'OPEN', 'PENDING', 'REJECTED'] as const;

/**
 * A claim payment is either an instalment against a claim still developing, or the one
 * that closes it. The distinction is what lets an analyst separate "paid so far" from
 * "finished" without joining back to the claim's status.
 */
export const ClaimPaymentTypes = ['INTERIM', 'FINAL'] as const;

export const UserRoles = ['EXECUTIVE', 'ANALYST'] as const;

export const ValidationStatuses = ['PERMITTED', 'REJECTED'] as const;

export const ExecutionStatuses = ['SUCCESS', 'ERROR', 'TIMEOUT', 'PROVIDER_UNAVAILABLE', 'NOT_ATTEMPTED'] as const;

/**
 * Presentations the system can render.
 *
 * `hbar` is the horizontal bar — the same encoding as `bar` turned on its side, which is
 * how long category labels (garage names, regions) stay readable without rotated text.
 * `donut` is offered only where parts genuinely sum to a whole; `chartSelector` decides,
 * not the model. There is no pie: a donut is the same chart with the useless centre
 * removed, and the hole is where the total goes.
 */
export const ChartTypes = ['kpi', 'bar', 'hbar', 'line', 'area', 'donut', 'table'] as const;

/** Knex `.checkIn()` wants a mutable array; the `as const` tuples above are readonly. */
export const asCheck = (values: readonly string[]): string[] => [...values];
