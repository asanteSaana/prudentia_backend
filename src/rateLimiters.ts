import {NextFunction, Request, RequestHandler, Response} from 'express';
import {ipKeyGenerator, rateLimit} from 'express-rate-limit';
import {Constants} from './_services/_constants';
import {createError} from './_services/errorService';
import {CustomRequest} from './_typings/types';

/**
 * Rate limiting (FR-18, TH-05, TH-08).
 *
 * **In-process store, and that is debt TD-F, not an oversight.** The limit is per
 * instance, so a horizontally scaled deployment multiplies it by the instance count and
 * a restart resets every bucket. Introducing Redis would have cost hours allocated to
 * security testing. The debt is named, costed at 3 hours, and repayable by swapping the
 * store — the shape below keeps that swap to one function.
 */

/** Emits the same envelope as the error middleware, so a 429 is not a special case. */
const rejection = (message: string) => (_req: Request, res: Response): void => {
	const error = createError(message, 429).toJSON();
	res.status(429).json({message: error.message, httpStatusCode: 429});
};

/**
 * Bucket by AUTHENTICATED USER where there is one, falling back to IP.
 *
 * FR-18 says *per-user*, and it has to: several analysts behind one office NAT share an
 * address, so an IP bucket would have them consuming each other's budget. The user id
 * comes from `req.user`, which the route decorator populates from a verified token, so
 * it cannot be spoofed by a header.
 *
 * `ipKeyGenerator` rather than `req.ip` directly — it normalises IPv6 to a subnet, so a
 * caller with a /64 cannot trivially rotate through addresses.
 */
const userOrIp = (req: Request): string => {
	const user = (req as CustomRequest).user;
	if (user?.id) return `u:${user.id}`;
	return `i:${ipKeyGenerator(req.ip ?? '')}`;
};

/**
 * The query endpoint (FR-18): 20 per minute per user.
 *
 * The bound is on COST, not on abuse alone — every question is an LLM call the operator
 * pays for and a database query under a 10-second ceiling.
 */
export const queryRateLimiter: RequestHandler = rateLimit({
	windowMs: 60_000,
	limit: Constants.QUERY_RATE_LIMIT_PER_MINUTE,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	keyGenerator: userOrIp,
	handler: rejection('Too many questions in a short period. Wait a minute and try again.')
});

/**
 * The login endpoint (TH-08): 10 attempts per minute per IP.
 *
 * Keyed by IP by necessity — there is no authenticated user yet, and keying on the
 * SUBMITTED email would let an attacker spread a credential-stuffing run across many
 * addresses for free while locking a real user out of their own account by name.
 *
 * scrypt's work factor is the primary control here; this bounds how fast that cost can
 * be imposed on the server.
 */
export const loginRateLimiter: RequestHandler = rateLimit({
	windowMs: 60_000,
	limit: Constants.LOGIN_RATE_LIMIT_PER_MINUTE,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	keyGenerator: (req: Request) => `i:${ipKeyGenerator(req.ip ?? '')}`,
	handler: rejection('Too many sign-in attempts. Wait a minute and try again.')
});

/**
 * Run an Express middleware from inside the route decorator.
 *
 * The decorator is where every cross-cutting concern lives in this template estate —
 * auth, validation, the transaction, the envelope — and there is no per-route
 * middleware chain to hook into. Rate limiting joins them rather than being bolted on
 * beside them, so a route cannot acquire a limiter and lose it in a refactor of how it
 * is mounted.
 *
 * Resolves `false` when the middleware has already answered the request (a 429), which
 * tells the decorator to stop without treating it as an error.
 */
export function runMiddleware(middleware: RequestHandler, req: Request, res: Response): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const next: NextFunction = (error?: unknown) => {
			if (error) reject(error);
			else resolve(true);
		};

		res.once('finish', () => resolve(false));
		Promise.resolve(middleware(req, res, next)).catch(reject);
	});
}
