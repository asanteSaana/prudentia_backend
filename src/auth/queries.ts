import {Knex} from 'knex';
import {ApplicationTables} from '../_services/_dbTables';
import {UserRecord} from './types';

export namespace Query {
	/**
	 * Looked up by exact lower-cased email. The column is UNIQUE and the schema
	 * lower-cases on the way in, so this cannot match two rows.
	 *
	 * Returns inactive users too — deliberately. The caller must distinguish "no such
	 * account" from "account disabled" internally while returning the SAME response for
	 * both (TH-08), and it cannot do that if the query has already collapsed them.
	 */
	export function findUserByEmail(knex: Knex, email: string): Promise<UserRecord | undefined> {
		return knex<UserRecord>(ApplicationTables.Users).where({email}).first();
	}

	export function findUserById(knex: Knex, id: number): Promise<UserRecord | undefined> {
		return knex<UserRecord>(ApplicationTables.Users).where({id}).first();
	}
}
