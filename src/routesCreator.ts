import {Express, NextFunction, RequestHandler, Response} from 'express';
import {existsSync, readdirSync} from 'fs';
import path from 'path';
import {z} from 'zod';
import {Constants, Database} from './_services';
import {BaseErrors, createError} from './_services/errorService';
import {CustomRequest, UserRole} from './_typings/types';
import {Authentication} from './auth/authService';
import {runMiddleware} from './rateLimiters';

/** The verbs a `__routes.ts` tuple may name. Constrained so `app[method]` is typed. */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

type TRoute = [HttpMethod, string, RequestHandler];

interface RouteParams {
	/** zod only. The template estate's Joi arm is deliberately not carried over (DV-7). */
	schema?: z.ZodType;
	/** Omit for "any authenticated user". FR-04, FR-05. */
	requiredRole?: UserRole;
	signInNotRequired?: boolean;
	shouldForwardApiResponse?: boolean;
	/**
	 * Rate limiter for this route (FR-18). Declared here rather than mounted beside the
	 * route because there is no per-route middleware chain in this template — the
	 * decorator is where every cross-cutting concern lives, so a route cannot acquire a
	 * limiter and then lose it in a refactor of how it is mounted.
	 */
	rateLimiter?: RequestHandler;
}

const getDirectories = () =>
	readdirSync(__dirname, {withFileTypes: true}).flatMap(file => (file.isDirectory() ? [file.name] : []));

/**
 * Routes are DISCOVERED, not imported: every directory under src/ is scanned for a
 * `__routes.ts` exporting a `routes` array of [method, path, handler] tuples.
 *
 * LANDMINE, inherited from the template estate and worth stating loudly: the filename
 * switches to `__routes.js` only when NODE_ENV === 'production'. In a deployed `dist/`
 * with any other value, `existsSync` misses every file — and a missing file is SKIPPED,
 * NOT AN ERROR. The app boots, /api/health returns 200, and every other route 404s in
 * silence. Nothing logs. If a deployment answers health checks but nothing else, this is
 * the first thing to check.
 */
export function getAllRoutes(): Array<TRoute> {
	const autoImportedRoutes: Array<TRoute> = [];
	const routesFile = process.env.NODE_ENV === 'production' ? '__routes.js' : '__routes.ts';

	getDirectories().forEach(folder => {
		const candidate = path.join(__dirname, folder, routesFile);
		if (existsSync(candidate)) {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const {routes} = require(candidate);
			autoImportedRoutes.push(...routes);
		}
	});

	return autoImportedRoutes;
}

export default function createRoutes(app: Express): void {
	getAllRoutes().forEach(([method, routePath, handler]) => {
		app[method](`/api${routePath}`, handler);
	});
}

/**
 * The decorator that does the work: authentication, the role guard, zod validation, the
 * request transaction, the response envelope, and the catch.
 *
 * Reduced from the template estate's version — the multi-tenant machinery (row-level
 * security, companyId scoping, company-type gates, API-key authentication) is not ported
 * because PrudenTia is single-organisation (DV-2). What remains is what FR-01 to FR-07
 * actually specify.
 */
export function route(params: RouteParams = {}) {
	const {schema, requiredRole, signInNotRequired = false, shouldForwardApiResponse = true, rateLimiter} = params;

	return function (target: any, _: string, descriptor: PropertyDescriptor) {
		const originalMethod = descriptor.value;

		descriptor.value = async function (req: CustomRequest, res: Response, next: NextFunction) {
			try {
				/**
				 * ORDER: authenticate, then rate-limit, then validate.
				 *
				 * Authentication first because FR-18's limit is *per user* and the key
				 * cannot be derived before the token is verified. Rate limiting before
				 * validation so a flood of malformed payloads is bounded by the same
				 * budget as well-formed ones — validation is cheap, but the LLM call and
				 * database query behind a valid request are not, and an attacker should
				 * not be able to probe the schema for free.
				 */
				if (!signInNotRequired) {
					const user = await Authentication.resolveUser(
						Database.getInstance(),
						req.headers.authorization
					);
					// FR-06: absent, malformed, expired and wrongly-signed tokens are
					// indistinguishable to the caller — all 401.
					if (!user) throw BaseErrors.AuthenticationFailed;
					req.user = user;

					// FR-05 / TH-07. Checked SERVER-SIDE. The client is never trusted to
					// enforce a role, and for the SQL field it is not even trusted to
					// hide one — see the response mapper.
					if (requiredRole && user.role !== requiredRole) throw BaseErrors.PermissionDenied;
				}

				if (rateLimiter) {
					const proceed = await runMiddleware(rateLimiter, req, res);
					// The limiter has already sent a 429; there is nothing left to do.
					if (!proceed) return;
				}

				if (schema) {
					const input = req.method === 'GET' || req.method === 'DELETE' ? req.body?.data ?? req.query : req.body?.data;
					const result = schema.safeParse(input);
					if (!result.success) {
						// The message is zod's, which describes the CALLER's own input —
						// no schema internals, so it is safe to return.
						throw createError(result.error.issues[0]?.message ?? 'Invalid request', 400);
					}

					/**
					 * Hand the handler the PARSED, COERCED value, not the raw body.
					 *
					 * This is why zod replaced Joi (DV-7). The template's Joi path
					 * validates and then forwards the original body, so `.trim()`,
					 * `.toLowerCase()` and defaults declared in a schema never reach the
					 * handler. For PrudenTia that is load-bearing: FR-08 caps a question
					 * at 500 characters, and a `.trim()` that silently does not apply
					 * means the length enforced is not the length declared.
					 */
					if (req.body?.data !== undefined) req.body.data = result.data;
					else (req as any).validated = result.data;
				}

				const data = await Database.getInstance().transaction(async trx => {
					req.trx = trx;
					return await originalMethod.apply(target, [req, res, next]);
				});

				const response = data?.data || data?.httpStatusCode ? {...data} : {data};
				if (shouldForwardApiResponse) return forwardApiRequestResponse(res, response);
				return response;
			} catch (error: any) {
				if (!Constants.IS_TEST && !Constants.IS_PRODUCTION) {
					console.error(error?.toJSON ? error.toJSON() : error);
				}
				next(error || createError('Unknown server error', 500));
			}
		};
	};
}

function forwardApiRequestResponse(res: Response, response: any) {
	const status = response?.httpStatusCode || 200;
	const body: Record<string, any> = {success: true, data: response?.data ?? {}};

	if (response?.metaData !== undefined) body.metaData = response.metaData;
	if (response?.pagination !== undefined) body.pagination = response.pagination;
	if (response?.message) body.message = response.message;
	if (response?.count !== undefined) body.count = response.count;

	res.status(status).json(body);
}
