import {ChartTypes} from '../_typings/dbEnums';
import {ChartType} from '../_typings/types';
import {ProviderResponse, ProviderUnavailableError} from './types';

/**
 * The tool contract, expressed once and shared by every vendor adapter (ADR-04, ADR-05).
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * PrudenTia can be pointed at Claude, at OpenAI, at an Azure OpenAI deployment, or at any
 * OpenAI-compatible server. Each of those has its own request shape. What must NOT vary
 * between them is the thing the architecture depends on:
 *
 *   1. There are exactly TWO outcomes — propose SQL, or decline. Two tools, never one
 *      schema with a mode flag, because a decline is a correct answer and not an error.
 *   2. A tool call is FORCED, so prose is structurally impossible rather than merely
 *      detectable.
 *   3. A response that is not a well-formed call to one of those two tools is treated as
 *      a provider failure and is NEVER read heuristically for something SQL-shaped.
 *
 * If each adapter carried its own copy of the schemas and its own parsing, rule 3 would
 * survive exactly as long as the most careless adapter. So the schemas live here, and
 * `interpretToolCall` is the single funnel every provider's response passes through.
 * A new vendor adapter supplies transport and nothing else.
 */

export const SQL_TOOL = 'propose_sql';
export const DECLINE_TOOL = 'decline';

/** JSON Schema shared by every vendor. `additionalProperties:false` + full `required` is what strict mode demands. */
export const SQL_TOOL_SCHEMA = {
	type: 'object',
	properties: {
		sql: {
			type: 'string',
			description: 'One PostgreSQL SELECT statement. No comments, no trailing semicolon needed.'
		},
		chart_type: {
			type: 'string',
			enum: [...ChartTypes],
			description:
				'How the result should be shown: kpi for a single value, line for a time series, bar for categories, table for three or more columns.'
		},
		explanation: {
			type: 'string',
			description:
				'One plain sentence naming what was measured and how it was grouped or filtered. The user reads this to check you understood the question they meant to ask.'
		}
	},
	required: ['sql', 'chart_type', 'explanation'],
	additionalProperties: false
} as const;

export const DECLINE_TOOL_SCHEMA = {
	type: 'object',
	properties: {
		reason: {
			type: 'string',
			description:
				'Why the question cannot be answered. Recorded in the audit log; the user sees a generic message.'
		}
	},
	required: ['reason'],
	additionalProperties: false
} as const;

export const SQL_TOOL_DESCRIPTION =
	'Answer the question with a single PostgreSQL SELECT statement. Use this whenever the question can be answered from the tables described in the system prompt.';

export const DECLINE_TOOL_DESCRIPTION =
	'Decline the question. Use this when it needs data that is not in the schema, asks to change data, concerns a named individual, asks for a prediction, or is not about the motor portfolio.';

/**
 * Turn a tool call into a `ProviderResponse`, or fail.
 *
 * **Every provider funnels through here.** The rules it enforces are the ones ADR-04
 * rests on, and enforcing them in one place is what stops a future adapter from being
 * slightly more forgiving than the others:
 *
 *  - An unknown tool name is a failure, not a guess.
 *  - Missing or non-string `sql` is a failure. There is no default, and no attempt to
 *    find SQL elsewhere in the response.
 *  - An unrecognised `chart_type` degrades to `table` rather than failing — that field is
 *    untrusted anyway and is reconciled against the real result shape downstream
 *    (ADR-08), so a bad hint costs a presentation choice, not an answer.
 *
 * @param toolName  The tool the model called.
 * @param rawArgs   Its arguments, already decoded from whatever the vendor's wire form was.
 */
export function interpretToolCall(toolName: string, rawArgs: unknown): ProviderResponse {
	const args = (rawArgs ?? {}) as Record<string, unknown>;

	if (toolName === DECLINE_TOOL) {
		const reason = typeof args.reason === 'string' ? args.reason : '';
		return {kind: 'decline', reason: reason || 'No reason given.'};
	}

	if (toolName === SQL_TOOL) {
		if (typeof args.sql !== 'string' || args.sql.trim().length === 0) {
			throw new ProviderUnavailableError('Provider proposal omitted the SQL field.');
		}

		const hint = typeof args.chart_type === 'string' ? args.chart_type : '';

		return {
			kind: 'sql',
			sql: args.sql,
			chartType: (ChartTypes as readonly string[]).includes(hint) ? (hint as ChartType) : 'table',
			explanation: typeof args.explanation === 'string' ? args.explanation : ''
		};
	}

	throw new ProviderUnavailableError(`Provider called an unknown tool: ${toolName}.`);
}
