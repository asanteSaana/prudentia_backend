import Anthropic from '@anthropic-ai/sdk';
import {Constants} from '../_services/_constants';
import {buildSystemPrompt, buildUserPrompt} from './contextAssembler';
import {
	DECLINE_TOOL,
	DECLINE_TOOL_DESCRIPTION,
	DECLINE_TOOL_SCHEMA,
	interpretToolCall,
	SQL_TOOL,
	SQL_TOOL_DESCRIPTION,
	SQL_TOOL_SCHEMA
} from './toolContract';
import {LlmProvider, ProviderResponse, ProviderUnavailableError} from './types';

/**
 * The real provider (ADR-04, ADR-05).
 *
 * ── Why tool use rather than structured outputs ──────────────────────────────
 *
 * The API also offers `output_config.format` with a JSON schema, which forces one fixed
 * shape. That is the wrong instrument here, because there are TWO valid outcomes: a
 * proposal, or a decline. Two tools express that directly — the model picks the one that
 * fits — where a single schema would have to encode the choice as a discriminated union
 * the model must remember to fill in correctly.
 *
 * `tool_choice: {type: 'any'}` forces at least one tool call, which is what makes
 * ADR-04's contract structural: **a prose reply becomes impossible rather than
 * detectable.** There is no heuristic extraction anywhere in this file, because there is
 * no prose to extract from.
 *
 * `strict: true` on both tools guarantees the arguments validate against the schema, so
 * a malformed proposal is rejected at the API boundary rather than by hand here.
 */

/**
 * The shared contract, wearing Anthropic's shape.
 *
 * Names, descriptions and schemas come from `toolContract.ts` so that Claude and every
 * OpenAI-compatible target are asked for the same two things in the same words. When the
 * wording of a tool description changes, it changes for all providers at once — otherwise
 * a model swap silently becomes a prompt change as well, and any accuracy difference
 * measured afterwards would be uninterpretable.
 */
const TOOLS: Anthropic.Tool[] = [
	{
		name: SQL_TOOL,
		description: SQL_TOOL_DESCRIPTION,
		strict: true,
		input_schema: SQL_TOOL_SCHEMA as unknown as Anthropic.Tool.InputSchema
	},
	{
		name: DECLINE_TOOL,
		description: DECLINE_TOOL_DESCRIPTION,
		strict: true,
		input_schema: DECLINE_TOOL_SCHEMA as unknown as Anthropic.Tool.InputSchema
	}
];

export class ClaudeProvider implements LlmProvider {
	private readonly client: Anthropic;

	constructor(
		apiKey: string,
		private readonly model: string
	) {
		this.client = new Anthropic({apiKey, maxRetries: 2, timeout: 60_000});
	}

	name(): string {
		return `claude:${this.model}`;
	}

	async generate(question: string): Promise<ProviderResponse> {
		let response: Anthropic.Message;

		try {
			response = await this.client.messages.create({
				model: this.model,
				max_tokens: 4096,
				/**
				 * Reasoning effort, SPREAD IN ONLY WHEN CONFIGURED (defect D-32).
				 *
				 * `output_config` is a newer-family parameter. Sending it unconditionally —
				 * which this adapter did — makes every older model 400, so a build that
				 * worked against `claude-opus-5` refused every question against
				 * `claude-sonnet-4-5` and reported it as an outage.
				 *
				 * It is the identical rule the OpenAI adapter already applied to
				 * `temperature`, and the reason is worth restating: a capability the newest
				 * model has is not a capability to assume. Effort is a latency/quality knob,
				 * not a safety control, so omitting it costs nothing structural.
				 */
				...(Constants.LLM_EFFORT
					? {output_config: {effort: Constants.LLM_EFFORT as Anthropic.OutputConfig['effort']}}
					: {}),
				/**
				 * The schema catalogue and glossary are identical on every request and run
				 * to several thousand tokens, so they are cached (the minimum cacheable
				 * prefix is 512 tokens on Opus 5). The question is deliberately in the
				 * `messages` array BELOW this breakpoint — putting anything per-request
				 * above it would invalidate the prefix on every call.
				 */
				system: [{type: 'text', text: buildSystemPrompt(), cache_control: {type: 'ephemeral'}}],
				messages: [{role: 'user', content: buildUserPrompt(question)}],
				tools: TOOLS,
				// THE contract. Forces a tool call, so free prose cannot be returned at all.
				tool_choice: {type: 'any'}
			});
		} catch (error: unknown) {
			// Typed exception chain, most specific first. Every branch collapses to the
			// same outcome for the caller — the distinction is for the log.
			if (error instanceof Anthropic.RateLimitError) {
				throw new ProviderUnavailableError('Provider rate limit reached.');
			}
			if (error instanceof Anthropic.AuthenticationError) {
				throw new ProviderUnavailableError('Provider credential rejected.');
			}
			if (error instanceof Anthropic.APIConnectionError) {
				throw new ProviderUnavailableError('Provider unreachable.');
			}
			/**
			 * The API's OWN explanation goes into the message — and therefore into
			 * `query_log.rejection_reason`, which is where an investigator reads it.
			 *
			 * It never reaches the client: the orchestrator replaces it with one fixed
			 * sentence and the error renderer strips everything else. Recording only
			 * "Provider returned 400." was the same mistake this project criticises
			 * elsewhere — an audit record that documents that something failed while
			 * discarding the only part that says why (defect D-33). It cost an hour of
			 * guessing which request parameter the model had rejected.
			 */
			if (error instanceof Anthropic.APIError) {
				const detail = typeof error.message === 'string' ? ` ${error.message.slice(0, 400)}` : '';
				throw new ProviderUnavailableError(`Provider returned ${error.status ?? 'an error'}.${detail}`);
			}
			throw new ProviderUnavailableError('Provider call failed.');
		}

		/**
		 * A safety classifier declined the request. This arrives as a normal HTTP 200
		 * with an empty or partial `content`, so reading `content[0]` first would throw
		 * on a perfectly successful response.
		 *
		 * It is treated as a DECLINE, not an outage: the model did answer, the answer was
		 * "no". A question about the portfolio should never trip this, but a
		 * security-flavoured phrasing occasionally does, and the user gets the same
		 * "rephrase" message as any other decline rather than a misleading 503.
		 */
		if (response.stop_reason === 'refusal') {
			return {
				kind: 'decline',
				reason: `Provider safety classifier declined the request (${response.stop_details?.category ?? 'no category'}).`
			};
		}

		const toolUse = response.content.find(
			(block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
		);

		/**
		 * No tool call despite `tool_choice: any`. Contract violation — treated as
		 * malformed and NEVER parsed heuristically out of whatever text came back
		 * (ADR-04). Reaching into prose for something SQL-shaped is exactly the parsing
		 * problem the structured contract exists to remove.
		 */
		if (!toolUse) {
			throw new ProviderUnavailableError(
				`Provider returned no tool call (stop_reason: ${response.stop_reason ?? 'unknown'}).`
			);
		}

		// Anthropic hands back decoded arguments; the OpenAI adapter hands back a JSON
		// string it parses first. Both then go through the SAME interpreter, which is where
		// "a missing sql field is a failure, not a default" is actually enforced.
		return interpretToolCall(toolUse.name, toolUse.input);
	}
}
