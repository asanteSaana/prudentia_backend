/**
 * Boot the COMPILED build in production mode and prove it serves.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Two deployment failures in a row came from code paths that only execute when
 * `NODE_ENV=production`, and which therefore no test could reach:
 *
 *   D-46  the migration directory was assembled as `dist/dist/_migrations`, because a
 *         branch that contributes an empty segment in dev contributed a literal `dist`
 *         in production, on top of a base that already ended in `dist`.
 *   D-47  the "listening" and "provider" lines were gated on `NODE_ENV !== 'production'`,
 *         so a deployed boot went silent after one line.
 *
 * `npm run verify` cannot catch either: it runs under NODE_ENV=test, from `src`, via
 * ts-jest. The only thing that exercises the production branches is running the
 * production artefact. That is all this does — build, boot, ask it three questions.
 *
 * It is deliberately NOT part of `verify`: it needs a database it is allowed to migrate
 * from scratch, so it is a pre-deploy check rather than a per-commit one.
 *
 *   npm run build && npm run smoke:prod
 *
 * ── POINT THIS AT A THROWAWAY DATABASE ──────────────────────────────────────
 *
 * Knex records each applied migration by FILENAME, extension included. Running here in
 * production mode writes `.js` names; the ts-jest suite writes `.ts` names. Whichever
 * runs first wins, and the other then reports "the migration directory is corrupt, the
 * following files are missing" — naming files that plainly exist, because it is looking
 * for the other extension.
 *
 * So a database smoked here can no longer be migrated by the test suite until its schema
 * is dropped. Use a scratch database, or reset afterwards:
 *
 *   DROP SCHEMA public CASCADE; CREATE SCHEMA public;
 */
const {spawn} = require('child_process');
const path = require('path');

const PORT = process.env.SMOKE_PORT || '8099';
const BASE = `http://localhost:${PORT}`;

const env = {
	...process.env,
	NODE_ENV: 'production',
	// The one production flag deliberately left off: it would force TLS to the database,
	// which a local PostgreSQL does not speak. Everything else runs the production path.
	IS_PRODUCTION: 'false',
	SSL_MODE_ENV: 'false',
	PORT,
	AUTH_JWT_KEY: process.env.AUTH_JWT_KEY || 'prod-smoke-key',
	LLM_PROVIDER: process.env.LLM_PROVIDER || 'stub'
};

const child = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {env});

/**
 * Report an early exit as itself.
 *
 * Without this, a process that died at boot — a refused startup assertion, a port already
 * in use — was only noticed 25 seconds later as "the log is missing 'listening on'",
 * which describes a symptom three steps downstream of the cause.
 */
child.on('exit', code => {
	if (!settled) {
		settled = true;
		console.log(log.trim());
		console.log(`
FAIL — the service exited during startup with code ${code}. The log above says why.`);
		process.exit(1);
	}
});

let log = '';
let settled = false;
child.stdout.on('data', chunk => (log += chunk));
child.stderr.on('data', chunk => (log += chunk));

const done = (ok, message) => {
	if (settled) return;
	settled = true;
	child.kill();
	console.log(log.trim());
	console.log(ok ? `\nPASS — ${message}` : `\nFAIL — ${message}`);
	process.exit(ok ? 0 : 1);
};

setTimeout(async () => {
	try {
		const health = await fetch(`${BASE}/api/health`).then(r => r.json());
		if (health.status !== 'healthy') return done(false, `health reported ${health.status}`);

		// 401, not 404. A 404 here is the NODE_ENV landmine: route discovery looks for
		// `__routes.js` only under NODE_ENV=production, and a missing file is skipped
		// silently — so health answers while every other route vanishes.
		const guarded = await fetch(`${BASE}/api/v1/metrics/headline`);
		if (guarded.status !== 401) return done(false, `versioned route returned ${guarded.status}, expected 401`);

		for (const line of ['Read-only role verified', 'LLM provider:', 'listening on']) {
			if (!log.includes(line)) return done(false, `startup log is missing "${line}"`);
		}

		done(true, 'production build migrates, mounts its routes, and reports itself');
	} catch (error) {
		done(false, `could not reach the service: ${error.message}`);
	}
}, 25000);
