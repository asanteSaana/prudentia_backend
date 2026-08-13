import {NextFunction, Response} from 'express';
import omit from 'lodash/omit';
import pick from 'lodash/pick';
import {BaseErrors, Constants, createError} from './_services';
import {BaseJSONError, CustomError, PostgresError} from './_typings/types';

export const four0FourHandler = (_: any, __: any, next: NextFunction) => {
	next(BaseErrors.EndpointNotFound);
};

/**
 * The single error exit (FR-16, NFR-08, TH-10).
 *
 * No database text, no parser text, no stack trace reaches the client — from ANY
 * environment, not merely production. The template strips 500 bodies only when
 * IS_PRODUCTION is set, which is a sensible default for an internal system but not for
 * one whose error messages are an oracle: the gate's `reason` and `failedCheck` would
 * be a map of the security boundary for anyone probing a staging deployment.
 */
export function renderError(err: CustomError, _: Express.Request, res: Response, __: NextFunction) {
	let error = BaseErrors.InternalServerError.toJSON() as BaseJSONError;

	/**
	 * Was this error AUTHORED by us, or did it merely arrive?
	 *
	 * The distinction decides whether its message may be sent (see the 5xx branch below).
	 * An authored message is a string in this repository; anything else is a string from
	 * a driver, a parser or a library, and those are the ones that carry internals.
	 */
	let authored = false;

	// body-parser rejections (malformed JSON, control characters in strings)
	if ((err as any).type === 'entity.parse.failed') {
		error = createError('Invalid JSON in request body', 400).toJSON();
	}

	// zod rejections, surfaced by the @route() decorator as a 400 already
	else if ((err as any).name === 'ZodError') {
		error = createError('Invalid request', 400).toJSON();
	}

	// deliberately thrown, already shaped
	else if (typeof err.toJSON === 'function') {
		error = err.toJSON();
		authored = true;
	}

	// Postgres, mapped to a sanitised status. NEVER forwards `detail`, which carries
	// column names, constraint names and sometimes row values.
	else if ('code' in err) {
		error = BaseErrors.getDBError(err as unknown as PostgresError).toJSON();
	}

	const status = error.httpStatusCode || error.status || 500;

	/**
	 * The full detail goes to the server log — where an investigator can read it and an
	 * attacker cannot. This asymmetry is the whole design (docs §6.2).
	 *
	 * ── Why the body is only scrubbed for UNAUTHORED 5xx (defect D-34) ─────────
	 *
	 * This branch used to replace every 5xx body with "Internal Server Error", which is
	 * right for an unexpected throw and wrong for the one 5xx this system raises on
	 * purpose. `BaseErrors.ProviderUnavailable` is a **503 whose wording is the feature**:
	 * "The analytics assistant is temporarily unavailable. The dashboard and your history
	 * still work." NFR-12's entire claim is that an LLM outage degrades the product rather
	 * than stopping it, and that sentence is how a user is told so. Scrubbing it replaced
	 * a precise, reassuring message with "Internal Server Error" — telling the user the
	 * system is broken when most of it is working, which is the opposite of the
	 * requirement, and worse than saying nothing.
	 *
	 * An authored message is a string literal in this repository. An unauthored one comes
	 * from a driver, a parser or a library — and those are exactly the ones that name
	 * columns, constraints and file paths. So the scrub follows authorship, not status.
	 */
	if (status >= 500) {
		console.error('..............INTERNAL-SERVER-ERROR...............\n', err?.toJSON?.() || err);
		res.status(status).json({message: authored ? error.message : 'Internal Server Error'});
		return;
	}

	if (!Constants.IS_PRODUCTION && !Constants.IS_TEST) {
		console.error('..............CLIENT-ERROR...............\n', error);
	}

	// `meta` is deliberately omitted from the response. It is a debugging aid for the
	// log, and the one place it could carry gate internals is exactly where it must not
	// be sent.
	res.status(status).json(omit(pick(error, ['message', 'httpStatusCode']), []));
}
