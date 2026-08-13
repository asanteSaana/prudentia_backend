import {UserRole} from '../_typings/types';

/**
 * What each role may SEE (FR-05, TH-07).
 *
 * The distinction between the two roles is behavioural, not cosmetic:
 *
 *   EXECUTIVE — answers and charts
 *   ANALYST   — additionally the generated SQL, the schema catalogue, rejection reasons
 *
 * ── Why this is a server-side projection and not a client concern ────────────
 *
 * The obvious implementation is to send everything and let the interface hide what the
 * role should not see. That is not authorisation, it is decoration: the payload is one
 * DevTools panel away, and "the field was there but we did not render it" is a
 * disclosure however tidy the UI looks.
 *
 * So the field is **deleted from the object** before serialisation. Test A-10 asserts
 * the KEY IS ABSENT from the JSON — not that it is null, not that it is empty. `null`
 * would still confirm the field exists and that this user is being denied it, which is
 * a smaller leak but a leak, and it makes the boundary look like a UI preference.
 *
 * Every response carrying generated SQL or a rejection reason goes through here. There
 * is deliberately no way to opt out.
 */

export interface AnalystOnlyFields {
	generatedSql?: string | null;
	failedCheck?: string | null;
	rejectionReason?: string | null;
}

/** Keys stripped for a non-ANALYST caller. Adding a field here is the only wiring needed. */
const ANALYST_ONLY_KEYS = ['generatedSql', 'failedCheck', 'rejectionReason'] as const;

export function isAnalyst(role: UserRole): boolean {
	return role === 'ANALYST';
}

/**
 * Project one object for a role. Returns a copy — the caller's object is not mutated,
 * because the same record is also written to the audit log, where the full detail MUST
 * be kept (ADR-07, NFR-15).
 */
export function projectForRole<T extends AnalystOnlyFields>(payload: T, role: UserRole): Partial<T> {
	if (isAnalyst(role)) return {...payload};

	const projected: Partial<T> = {...payload};
	for (const key of ANALYST_ONLY_KEYS) {
		// `delete`, not `= null`. The key must not appear in the serialised JSON at all.
		delete projected[key as keyof T];
	}
	return projected;
}

/** The same projection across a list — query history (FR-25) uses this. */
export function projectListForRole<T extends AnalystOnlyFields>(payloads: T[], role: UserRole): Array<Partial<T>> {
	return payloads.map(payload => projectForRole(payload, role));
}
