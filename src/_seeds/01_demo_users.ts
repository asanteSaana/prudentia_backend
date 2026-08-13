import type {Knex} from 'knex';
import {hashPassword} from '../_services/authService';

/**
 * The two demonstration accounts (prompt pack Phase 1 item 8).
 *
 * The role difference is behavioural, not cosmetic (FR-05): an ANALYST sees the
 * generated SQL, the schema catalogue and rejection reasons; an EXECUTIVE does not —
 * and the field is OMITTED FROM THE RESPONSE PAYLOAD rather than hidden by the client
 * (TH-07).
 *
 * Emails are stored lower-cased and compared lower-cased. Storing them as typed would
 * make `Exec@PrudenTia.demo` and `exec@prudentia.demo` two different accounts against a
 * UNIQUE column, which is a support problem rather than a security one but is trivially
 * avoided here.
 */
export async function seed(knex: Knex): Promise<void> {
	// Same reason as the analytics seed: name the database before writing to it.
	const target = knex.client.config.connection as {host?: string; database?: string};
	console.log(`Seeding users into "${target?.database}" at ${target?.host}.`);

	await knex('users').del();

	await knex('users').insert([
		{
			email: 'exec@prudentia.demo',
			password_hash: hashPassword('Executive#2026'),
			full_name: 'Afua Amoa Boatemaa',
			role: 'EXECUTIVE',
			is_active: true
		},
		{
			email: 'analyst@prudentia.demo',
			password_hash: hashPassword('Analyst#2026'),
			full_name: 'Janet Sarpomaa',
			role: 'ANALYST',
			is_active: true
		}
	]);

	// Each hash carries its own random salt, so the two rows differ even where the
	// passwords share a pattern. Asserted by test A-13.
	console.log('Seeded 2 demonstration users (EXECUTIVE, ANALYST).');
}
