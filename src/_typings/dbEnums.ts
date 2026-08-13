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

export const UserRoles = ['EXECUTIVE', 'ANALYST'] as const;

export const ValidationStatuses = ['PERMITTED', 'REJECTED'] as const;

export const ExecutionStatuses = ['SUCCESS', 'ERROR', 'TIMEOUT', 'PROVIDER_UNAVAILABLE', 'NOT_ATTEMPTED'] as const;

export const ChartTypes = ['kpi', 'bar', 'line', 'table'] as const;

/** Knex `.checkIn()` wants a mutable array; the `as const` tuples above are readonly. */
export const asCheck = (values: readonly string[]): string[] => [...values];
