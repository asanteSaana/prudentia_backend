/**
 * Environment is read ONCE, here, into a typed object. Nothing else in the codebase
 * touches process.env — matching the template convention.
 *
 * Numeric values are parsed defensively with a documented fallback. A non-numeric
 * env var must not silently become NaN: every comparison against NaN is false, so a
 * typo in MAX_RESULT_ROWS would not raise the ceiling, it would switch it OFF.
 * That failure mode is the reason this file looks more paranoid than it needs to.
 */

/** Parse a positive integer, falling back on anything missing, non-numeric or ≤ 0. */
function positiveInt(raw: string | undefined, fallback: number): number {
	const parsed = parseInt(raw ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const Constants = {
	IS_PRODUCTION: process.env.IS_PRODUCTION === 'true',
	IS_DEV: process.env.NODE_ENV === 'development',
	IS_TEST: process.env.NODE_ENV === 'test',
	ENV: process.env.NODE_ENV,
	SSL_MODE: process.env.SSL_MODE_ENV === 'true',

	/** Read-write: migrations, seeds, auth, audit log. NEVER generated SQL. */
	DB_CONNECTION: {
		host: process.env.DATABASE_HOST,
		user: process.env.DATABASE_USER,
		database: process.env.DATABASE_NAME,
		password: process.env.DATABASE_PASSWORD,
		port: positiveInt(process.env.DATABASE_PORT, 5432)
	},

	/**
	 * SELECT-only: generated SQL and nothing else (ADR-03, NFR-02, CLAUDE.md §4 rule 4).
	 * Same host/database, different role. The separation is the whole point, so these
	 * are deliberately NOT defaulted to the read-write credentials — a missing value
	 * must fail loudly at boot, not silently fall back to a privileged role.
	 */
	DB_READONLY_CONNECTION: {
		host: process.env.DATABASE_HOST,
		user: process.env.DATABASE_RO_USER,
		database: process.env.DATABASE_NAME,
		password: process.env.DATABASE_RO_PASSWORD,
		port: positiveInt(process.env.DATABASE_PORT, 5432)
	},

	AUTH_JWT_KEY: process.env.AUTH_JWT_KEY,
	/** NFR-06 — tokens expire within 60 minutes of issue. */
	JWT_EXPIRY_MINUTES: positiveInt(process.env.JWT_EXPIRY_MINUTES, 60),

	/** FR-13 — row ceiling. */
	MAX_RESULT_ROWS: positiveInt(process.env.MAX_RESULT_ROWS, 1000),
	/** NFR-11 — statement timeout, also set on the read-only role in a migration. */
	STATEMENT_TIMEOUT_MS: positiveInt(process.env.STATEMENT_TIMEOUT_MS, 10000),
	/** FR-08 — maximum question length, applied to the TRIMMED value. */
	MAX_QUESTION_LENGTH: positiveInt(process.env.MAX_QUESTION_LENGTH, 500),
	/** FR-18 — per-user rate limit on the query endpoint. */
	QUERY_RATE_LIMIT_PER_MINUTE: positiveInt(process.env.QUERY_RATE_LIMIT_PER_MINUTE, 20),
	/**
	 * TH-08 — per-IP limit on the login endpoint. Configurable so the integration suite
	 * can raise it (dozens of legitimate logins from one address would otherwise trip
	 * it) and lower it in the one test that asserts the limiter actually fires.
	 * A limiter whose threshold no test can reach is a limiter nobody has verified.
	 */
	LOGIN_RATE_LIMIT_PER_MINUTE: positiveInt(process.env.LOGIN_RATE_LIMIT_PER_MINUTE, 10),

	/**
	 * ── Model provider (ADR-05, NFR-16) ──────────────────────────────────────
	 *
	 * `claude` | `openai` | `azure-openai` | `stub`. Anything unrecognised, or a selection
	 * whose credentials are missing, falls back to the stub with a warning — see
	 * `src/llm/index.ts` for why that is a degradation and not a failure.
	 */
	LLM_PROVIDER: process.env.LLM_PROVIDER || 'stub',

	/**
	 * The model, for every provider that names one in the request body.
	 *
	 * Azure is the exception: it routes by *deployment* in the URL, and the deployment
	 * name is chosen by whoever deployed it and need not match any published model id.
	 * That is why `AZURE_OPENAI_DEPLOYMENT` is separate rather than derived from this.
	 *
	 * `ANTHROPIC_MODEL` is still read as a fallback so an existing `.env` keeps working
	 * after the rename.
	 */
	LLM_MODEL: process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-5',

	/**
	 * Sampling temperature, or `null` to omit the field entirely.
	 *
	 * OMITTED is the meaningful case, not a tidiness preference: reasoning models
	 * (o-series and newer families) reject `temperature` with a 400, so a hard-coded
	 * default would make this build silently incompatible with the models most likely to
	 * be deployed next. `LLM_TEMPERATURE=` (empty) omits it; `0` is the default because
	 * NL→SQL wants the most probable statement, not a varied one.
	 */
	LLM_TEMPERATURE: (() => {
		const raw = process.env.LLM_TEMPERATURE;
		if (raw === undefined) return 0;
		if (raw.trim() === '') return null;
		const parsed = parseFloat(raw);
		return Number.isFinite(parsed) ? parsed : 0;
	})(),

	/**
	 * Reasoning effort, or empty to OMIT the parameter entirely. Empty is the default.
	 *
	 * This is the same rule as `LLM_TEMPERATURE`, learned the hard way in the other
	 * direction (defect D-32): `output_config: {effort}` exists only on the newer Claude
	 * families, and sending it unconditionally made the adapter reject *older* models with
	 * a 400. A capability the newest model has is not a capability to assume.
	 *
	 * Set it (`low` | `medium` | `high` | `xhigh` | `max`) only when the configured model
	 * is known to support it.
	 */
	LLM_EFFORT: (process.env.LLM_EFFORT ?? '').trim(),

	ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,

	OPENAI_API_KEY: process.env.OPENAI_API_KEY,
	/** Points at OpenAI unless overridden — vLLM, Ollama's OpenAI shim, a gateway. */
	OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
	/** A custom base URL may legitimately need no credential; api.openai.com may not. */
	OPENAI_BASE_URL_IS_CUSTOM: Boolean(process.env.OPENAI_BASE_URL),

	AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
	AZURE_OPENAI_API_KEY: process.env.AZURE_OPENAI_API_KEY,
	AZURE_OPENAI_DEPLOYMENT: process.env.AZURE_OPENAI_DEPLOYMENT,
	AZURE_OPENAI_API_VERSION: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',

	/** Empty disables cross-origin access entirely. No trailing slashes. */
	CORS_ALLOWED_ORIGINS: (process.env.CORS_ALLOWED_ORIGINS || '')
		.split(',')
		.map(origin => origin.trim().replace(/\/$/, ''))
		.filter(Boolean)
};
