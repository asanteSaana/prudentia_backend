import {Response} from 'express';
import {loginRateLimiter} from '../rateLimiters';
import {CustomRequest} from '../_typings/types';
import {route} from '../routesCreator';
import {Authentication} from './authService';
import {LoginSchema} from './schema';

class AuthHandler {
	/**
	 * FR-01, FR-03. Authenticate and issue a token.
	 *
	 * `signInNotRequired` because there is obviously no session yet. Rate-limited by IP
	 * (TH-08): scrypt's work factor is the primary cost imposed on an attacker, and this
	 * bounds how fast that cost can be demanded of the server.
	 */
	@route({schema: LoginSchema, signInNotRequired: true, rateLimiter: loginRateLimiter})
	static async login(req: CustomRequest, _res: Response) {
		const result = await Authentication.login(req.trx, req.body.data);
		return {data: result, message: 'Signed in'};
	}

	/**
	 * FR-07. End the session.
	 *
	 * There is nothing server-side to invalidate: the token is stateless and stays valid
	 * until it expires (TD-I). The client discards it. Saying so plainly here is better
	 * than an endpoint that implies a revocation it does not perform — a maintainer who
	 * believes logout revokes will not reach for the denylist when it matters.
	 */
	@route()
	static async logout(_req: CustomRequest, _res: Response) {
		return {data: {}, message: 'Signed out'};
	}

	/** Current identity and role, for the client to shape its own navigation. */
	@route()
	static async me(req: CustomRequest, _res: Response) {
		return {
			data: {
				email: req.user.email,
				fullName: req.user.fullName,
				role: req.user.role
			}
		};
	}
}

export default AuthHandler;
