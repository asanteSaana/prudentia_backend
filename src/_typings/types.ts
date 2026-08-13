import {ChartTypes, ExecutionStatuses, UserRoles, ValidationStatuses} from './dbEnums';
import {Request} from 'express';
import {Knex} from 'knex';

export type UserRole = (typeof UserRoles)[number];

export interface AuthenticatedUser {
	id: number;
	email: string;
	fullName: string;
	role: UserRole;
	isActive: boolean;
}

/** Express request, after `@route()` has authenticated and opened the transaction. */
export interface CustomRequest extends Request {
	user: AuthenticatedUser;
	trx: Knex.Transaction;
}

export interface BaseJSONError {
	message?: string;
	httpStatusCode?: number;
	status?: number;
	meta?: any;
	date?: string;
}

export interface CustomError extends Error {
	toJSON?: () => BaseJSONError;
	httpStatusCode?: number;
}

export interface PostgresError extends Error {
	code: string;
	detail?: string;
	constraint?: string;
}

/** Outcome of the validation gate. `reason`/`failedCheck` are for the audit log ONLY. */
export interface ValidationResult {
	permitted: boolean;
	normalisedSql: string | null;
	reason: string | null;
	failedCheck: string | null;
}

/**
 * DERIVED from `dbEnums.ts`, not restated.
 *
 * These were hand-written unions duplicating the tuples that also drive the CHECK
 * constraints and the LLM's value lists. Adding `hbar`, `area` and `donut` to the enum
 * left this union behind, and every use site type-errored — which was the good outcome.
 * The bad one is a union that is quietly WIDER than the constraint: the compiler would
 * then bless a value the database rejects at insert time, which is the drift `dbEnums.ts`
 * exists to prevent.
 */
export type ValidationStatus = (typeof ValidationStatuses)[number];
export type ExecutionStatus = (typeof ExecutionStatuses)[number];
export type ChartType = (typeof ChartTypes)[number];
