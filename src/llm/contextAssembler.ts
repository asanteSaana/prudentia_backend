import {Constants} from '../_services/_constants';
import {renderSchemaForLlm} from '../guard/catalogue';

/**
 * Stage 2 of the pipeline: build the context the model is given (FR-09, ADR-06).
 *
 * Three parts, and the order matters for prompt caching: schema description, metric
 * glossary, generation rules — all stable — then the question, which is not. Anything
 * volatile placed above the stable content would invalidate the cache prefix on every
 * request.
 *
 * NEVER table contents. Structure and definitions only. Sample rows would export
 * commercially sensitive data to a third-party processor, and the accuracy they would
 * buy is bought instead by the glossary: "loss ratio" means one thing here, every time,
 * which is the control for the principal correctness risk (R-01).
 */

/**
 * The generation rules.
 *
 * Written as *constraints and reasons*, not as a numbered procedure. Current models
 * follow prescriptive step-by-step scripts literally and produce worse SQL for it; what
 * they need is the boundary and the domain trap, then their own plan.
 *
 * Every rule here exists because breaking it produces a plausible-but-wrong number or a
 * statement the gate will refuse — the two failure modes that matter.
 */
const GENERATION_RULES = `
RULES

Produce exactly one PostgreSQL SELECT statement. Anything else — multiple statements,
any write, any DDL, SELECT INTO, FOR UPDATE — is refused before it runs, so proposing
one wastes the user's question.

Use only the tables and columns listed above. There are no other tables. In particular
there is no user, account, credential or audit table reachable from here; a question
that needs one cannot be answered and should be declined.

Never write a SQL comment. Comments are rejected on sight, so a statement carrying one
is refused however correct its logic.

Schema-qualify nothing, or qualify with public. Any other schema is refused.

Use the metric definitions exactly as given. They are the reason two askings of the same
question agree. Loss ratio in particular divides incurred_amount by earned_premium —
written_premium is a different number and produces a confidently wrong answer.

After an outer join, count the joined table's id (COUNT(c.id)), never COUNT(*).
COUNT(*) counts rows that matched nothing, which silently turns "policies with no
claims" into "policies with one claim" and understates every frequency.

A claim's region is reached through claims -> policies -> customers -> regions. A query
that skips a step is measuring something else.

settlement_date is NULL until a claim settles. Settlement cycle time is defined over
settled claims only, so filter on settlement_date IS NOT NULL rather than letting NULLs
fall through an aggregate.

Prefer a small result. A question answered by one number should return one row, not a
thousand the interface then has to summarise.

Recommend a chart type from the shape you expect: kpi for a single value, line for a
time series, bar for categories, table for three or more columns. The recommendation is
checked against the actual result and corrected if it does not fit, so an honest guess
is better than a defensive one.

Decline — using the decline tool — when the question needs data that is not here, asks
to change data, is about a named individual, asks for a prediction, or is not about the
motor portfolio at all. Declining is a correct answer, not a failure.
`.trim();

/**
 * The system prompt. Deterministic and stable across requests, which is what makes it
 * cacheable — see the `cache_control` breakpoint in the Claude provider.
 */
export function buildSystemPrompt(): string {
	return [
		'You translate business questions about a motor insurance portfolio into PostgreSQL SELECT statements.',
		'',
		'You are one component of a governed pipeline. Every statement you propose is parsed and',
		'validated against a whitelist before any execution decision is made, then executed through a',
		'read-only role under a 10-second timeout and a 1000-row ceiling. You cannot damage anything;',
		'you can, however, produce a plausible number that is quietly wrong, and that is the failure',
		'that matters. Prefer declining to guessing.',
		'',
		renderSchemaForLlm(),
		'',
		GENERATION_RULES
	].join('\n');
}

/** FR-08 — the question, trimmed and bounded, is all the per-request context there is. */
export function buildUserPrompt(question: string): string {
	return question.trim().slice(0, Constants.MAX_QUESTION_LENGTH);
}
