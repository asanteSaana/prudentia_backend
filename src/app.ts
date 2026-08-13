import cors from 'cors';
import express, {Express} from 'express';
import helmet from 'helmet';
import {Constants, Database} from './_services';
import {four0FourHandler, renderError} from './middleware';
import createRoutes from './routesCreator';

export function createServer(app: Express): Express {
	app.use(helmet());

	/**
	 * CORS is an explicit allowlist, not a wildcard. Empty disables cross-origin access
	 * entirely, which is the correct default for a service whose only client is a known
	 * SPA. Origins are compared without a trailing slash — a trailing slash never
	 * matches, and that has cost time in this template estate before (Phase 8 runbook).
	 *
	 * ── Loopback is additionally allowed OUTSIDE production, and that is deliberate ──
	 *
	 * Vite does not fail when its port is taken: it walks 5173 → 5174 → 5175 → … and
	 * prints whichever it settled on. With a fixed single origin, the interface then comes
	 * up on a port the API has never heard of, renders perfectly, and every request fails
	 * CORS — a failure that looks like a broken app rather than a config mismatch. It cost
	 * real time in this build (deviation DV-20), and pinning one more port each time it
	 * happens is not a fix, it is a queue of the same bug.
	 *
	 * The exemption is bounded on both sides: it is off when IS_PRODUCTION is set, and it
	 * only ever matches loopback, which cannot be reached from another machine. A deployed
	 * instance therefore still answers exactly one origin — the Static Web Apps hostname.
	 */
	const loopback = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

	app.use(
		cors({
			origin: (origin, callback) => {
				// Same-origin and non-browser callers (curl, the smoke script) send no Origin.
				if (!origin) return callback(null, true);
				if (Constants.CORS_ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ''))) return callback(null, true);
				if (!Constants.IS_PRODUCTION && loopback.test(origin)) return callback(null, true);
				return callback(null, false);
			},
			credentials: false
		})
	);

	// A question is capped at 500 characters (FR-08); nothing this API accepts is large.
	// A small limit is a cheap bound on a whole class of resource-exhaustion attempts.
	app.use(express.json({limit: '64kb'}));
	app.use(express.urlencoded({extended: true, limit: '64kb'}));

	/**
	 * Liveness plus dependency status (docs §8.1).
	 *
	 * Registered directly here rather than through the route decorator so it needs no
	 * authentication and opens no transaction — a health check that requires the database
	 * to be healthy in order to report on the database is useless exactly when it matters.
	 *
	 * **Degraded is not down.** A missing provider returns 200 with
	 * `provider: "stub"`, because the dashboard and history still work (NFR-12) and a
	 * load balancer must not pull the instance for it. Only the database being
	 * unreachable is a 503, because nothing works without it.
	 *
	 * Nothing here names a host, a driver or a credential: the payload is unauthenticated
	 * and readable by anyone who can reach the service.
	 */
	app.get('/api/health', async (_req, res) => {
		let database: 'up' | 'down' = 'down';
		try {
			await Database.getInstance().raw('SELECT 1');
			database = 'up';
		} catch {
			// Deliberately swallowed. The status field IS the report; the driver's message
			// would name the host and is not for an unauthenticated caller.
		}

		const provider = Constants.LLM_PROVIDER === 'claude' && Constants.ANTHROPIC_API_KEY ? 'claude' : 'stub';

		res.status(database === 'up' ? 200 : 503).json({
			status: database === 'up' ? 'healthy' : 'unhealthy',
			database,
			provider,
			timestamp: new Date().toISOString()
		});
	});

	createRoutes(app);

	app.use(four0FourHandler);
	app.use(renderError);

	process.on('unhandledRejection', (reason: Error) => {
		throw reason;
	});

	process.on('uncaughtException', (error: Error) => {
		console.error('::::::::::::UNCAUGHT EXCEPTION::::::::::::', error);
		process.exit(1);
	});

	return app;
}
