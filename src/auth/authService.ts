import {addMinutes} from 'date-fns';
import {Knex} from 'knex';
import nJwt from 'njwt';
import {Constants} from '../_services/_constants';
import {DUMMY_PASSWORD_HASH, extractJwtFromAuthString, verifyPassword} from '../_services/authService';
import {BaseErrors} from '../_services/errorService';
import {AuthenticatedUser, UserRole} from '../_typings/types';
import {Query} from './queries';
import {LoginInput} from './schema';
import {LoginResult} from './types';

/**
 * Authentication and the session token (FR-01 – FR-07, NFR-06, TH-06, TH-08).
 *
 * The token is a signed JWT and is NOT persisted. The template estate stores every
 * issued token in a table and re-verifies it per request, which makes revocation
 * possible — a genuinely stronger control. It is deliberately not adopted here
 * (conflict C-3): the specification's debt register carries **TD-I, "JWT cannot be
 * revoked before expiry"**, as a named, costed, accepted compromise, and retiring a
 * debt entry by accident is worse than carrying it honestly. Revisit as a decision, not
 * as a side effect.
 */

const ISSUER = 'prudentia-api';

/**
 * Claims are all strings, deliberately.
 *
 * njwt types its claim bag as `{[key: string]: JSONValue}`, so an index signature is
 * required — and typing it `string` rather than `unknown` keeps the compiler enforcing
 * that nothing structured is ever put in a token. A JWT is signed, not encrypted, and
 * travels in a header the client can read: keeping the payload to five flat identifiers
 * makes "did we just put something in here that should not be public?" answerable by
 * looking at the type.
 */
interface TokenClaims {
	sub: string;
	email: string;
	fullName: string;
	role: UserRole;
	iss: string;
	[claim: string]: string;
}

export namespace Authentication {
	/**
	 * FR-01, FR-03. Verifies credentials and issues a token.
	 *
	 * TH-08 — unknown email and wrong password must be **indistinguishable**, in both
	 * the response and the time taken:
	 *
	 *  - Both throw the SAME `AuthenticationFailed`, so the bodies are byte-identical
	 *    (test A-03).
	 *  - An unknown email still runs a scrypt verification, against a fixed dummy hash.
	 *    Without it the unknown-email path returns in microseconds while a real account
	 *    spends ~80 ms hashing, and the endpoint enumerates valid accounts by stopwatch.
	 *    A byte-identical response with a distinguishable latency is still an oracle.
	 *  - A disabled account takes the same path, for the same reason.
	 */
	export async function login(knex: Knex, input: LoginInput): Promise<LoginResult> {
		const user = await Query.findUserByEmail(knex, input.email);

		const passwordMatches = verifyPassword(input.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);

		if (!user || !user.is_active || !passwordMatches) {
			throw BaseErrors.AuthenticationFailed;
		}

		const expiresAt = addMinutes(new Date(), Constants.JWT_EXPIRY_MINUTES);
		const claims: TokenClaims = {
			sub: String(user.id),
			email: user.email,
			fullName: user.full_name,
			role: user.role,
			iss: ISSUER
		};

		const jwt = nJwt.create(claims, Constants.AUTH_JWT_KEY as string);
		// NFR-06 — 60 minutes by default, never longer than configured.
		jwt.setExpiration(expiresAt);

		return {
			accessToken: jwt.compact(),
			email: user.email,
			fullName: user.full_name,
			role: user.role,
			expiresAt: expiresAt.toISOString()
		};
	}

	/**
	 * FR-06. Resolves a bearer token to a user, or returns null.
	 *
	 * Returns null rather than throwing on every failure mode — absent, malformed,
	 * expired, wrongly signed — because the caller turns all of them into the same 401.
	 * Distinguishing them to the client would say whether a token was ever valid.
	 *
	 * The issuer claim is verified explicitly. `njwt` validates the signature and
	 * expiry; it does not care who issued the token, so a token signed with the same
	 * secret by another service in the same estate would otherwise authenticate here.
	 */
	export async function resolveUser(knex: Knex, authHeader?: string): Promise<AuthenticatedUser | null> {
		if (!authHeader) return null;

		const token = extractJwtFromAuthString(authHeader);
		if (!token) return null;

		let claims: TokenClaims;
		try {
			const verified = nJwt.verify(token, Constants.AUTH_JWT_KEY as string);
			claims = verified?.body as unknown as TokenClaims;
		} catch {
			// Covers a forged signature, the wrong secret, expiry and malformed input.
			return null;
		}

		if (!claims || claims.iss !== ISSUER) return null;

		const id = parseInt(claims.sub, 10);
		if (!Number.isFinite(id)) return null;

		/**
		 * The user is re-read on every request rather than trusted from the token.
		 *
		 * The token carries the role, and a token is a bearer credential valid until it
		 * expires — so a role changed or an account disabled after issue would otherwise
		 * keep working for up to an hour. Reading the row makes deactivation immediate,
		 * which is the part of revocation worth having without a denylist (TD-I).
		 */
		const user = await Query.findUserById(knex, id);
		if (!user || !user.is_active) return null;

		return {
			id: user.id,
			email: user.email,
			fullName: user.full_name,
			role: user.role,
			isActive: user.is_active
		};
	}
}
