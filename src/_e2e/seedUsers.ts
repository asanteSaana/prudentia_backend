import {Knex} from 'knex';
import {hashPassword} from '../_services/authService';
import {UserRole} from '../_typings/types';

export interface TestUser {
	id: number;
	email: string;
	password: string;
	role: UserRole;
}

/**
 * Insert a user for a test, with a real scrypt hash.
 *
 * The hash is genuine rather than a fixture: the login path's cost and its
 * constant-time comparison are part of what is under test (A-13, TH-08), and a
 * short-circuited fake would test the short circuit.
 */
export async function addUser(
	knex: Knex,
	options: {email: string; password: string; role: UserRole; isActive?: boolean}
): Promise<TestUser> {
	const [row] = await knex('users')
		.insert({
			email: options.email.toLowerCase(),
			password_hash: hashPassword(options.password),
			full_name: `Test ${options.role}`,
			role: options.role,
			is_active: options.isActive ?? true
		})
		.returning<Array<{id: number}>>('id');

	return {id: row.id, email: options.email.toLowerCase(), password: options.password, role: options.role};
}

export const EXECUTIVE_CREDENTIALS = {email: 'exec.test@prudentia.demo', password: 'Executive#2026'};
export const ANALYST_CREDENTIALS = {email: 'analyst.test@prudentia.demo', password: 'Analyst#2026'};
