import {PostgresError} from '../_typings/types';

/**
 * NOTE, because this has shipped bugs in the template estate: `createError` returns an
 * object carrying ONLY `toJSON()`. It is not an Error and it has no `.message` or
 * `.httpStatusCode` property. Reading `error.message` off one of these yields
 * `undefined` silently.
 *
 * Always go through `.toJSON()`.
 */
export function createError(message: string, httpStatusCode = 400, meta?: any) {
	const error = new Error(message);
	if (Error.captureStackTrace) Error.captureStackTrace(error, createError);

	return {
		toJSON: () => ({
			message,
			httpStatusCode,
			meta: meta || undefined,
			date: new Date().toISOString()
		})
	};
}

export const BaseErrors = {
	getDBError: (error: PostgresError) => {
		// Map Postgres SQLSTATE codes to sanitised client statuses. Default to 400 so a
		// driver-level surprise does not surface as a 500 carrying internal text.
		const codeMap: Record<string, {status: number; message: string}> = {
			'23505': {status: 409, message: 'Duplicate Entry'},
			'23503': {status: 400, message: 'Invalid Reference'},
			'23502': {status: 400, message: 'Missing Required Field'},
			'23514': {status: 400, message: 'Invalid Value'},
			'22001': {status: 400, message: 'Value Too Long'},
			'22003': {status: 400, message: 'Numeric Value Out Of Range'},
			'22007': {status: 400, message: 'Invalid Date/Time Format'},
			'42703': {status: 400, message: 'Invalid Field'},
			'42P01': {status: 400, message: 'Invalid Resource'}
		};

		const mapped = codeMap[error.code];
		if (mapped) return createError(mapped.message, mapped.status);

		// NOTE the difference from the template, which falls back to `error.detail`.
		// Postgres puts column names, constraint names and sometimes row values in
		// `detail`; forwarding it is precisely the schema-internals leak TH-10 and
		// NFR-08 forbid. The detail goes to the server log, never to the client.
		return createError('Database Error', 500);
	},

	AuthenticationFailed: createError('Authentication Failed', 401),
	PermissionDenied: createError('Permission Denied', 403),
	EndpointNotFound: createError('Endpoint not found', 404),
	InternalServerError: createError('Internal Server Error', 500),

	/**
	 * THE user-facing rejection message (FR-16, CLAUDE.md §4 rule 7, TD-Q).
	 *
	 * One fixed sentence for every rejection, whatever the reason. A message naming the
	 * failed check — "table `users` is not whitelisted" — is an oracle: it tells someone
	 * probing the gate exactly which of the ten checks they tripped and therefore how to
	 * work around it. The real reason and failed check are written to query_log, which
	 * is where an investigator can read them and an attacker cannot.
	 *
	 * The usability cost is real, accepted, and recorded as TD-Q.
	 */
	QuestionRefused: createError(
		'That question could not be answered safely. Try rephrasing it in terms of policies, claims, premiums, garages or regions.',
		400
	),

	ProviderUnavailable: createError(
		'The analytics assistant is temporarily unavailable. The dashboard and your history still work.',
		503
	),

	QueryTimedOut: createError('That question took too long to answer. Try narrowing it to a shorter period or one segment.', 400)
};

export const ErrorCode = {
	DuplicateEntry: '23505',
	ForeignKeyViolation: '23503',
	/** Raised when a write is attempted on the SELECT-only connection. */
	ReadOnlySqlTransaction: '25006',
	InsufficientPrivilege: '42501',
	QueryCanceled: '57014'
};
