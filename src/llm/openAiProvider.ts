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
 * Every OpenAI Chat Completions endpoint, in one adapter (ADR-05, NFR-16).
 *
 * ── What this covers, and why it is one class and not three ──────────────────
 *
 *   OpenAI            https://api.openai.com/v1/chat/completions      Authorization: Bearer
 *   Azure OpenAI      {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…
 *                                                                     api-key: …
 *   Anything else     any server speaking the same wire format — vLLM, Ollama's OpenAI
 *                     shim, LM Studio, a model deployed behind a gateway
 *
 * The three differ in **URL shape, auth header, and where the model name goes** — and in
 * nothing else that matters. Three files would be three copies of the same tool
 * declaration and the same response parsing, and it is the parsing that carries the
 * safety rule (never read prose for SQL). One transport description and one parser keeps
 * that rule single-sourced. This mirrors the arrangement in the reference Azure project,
 * which likewise treats Azure as an OpenAI-compatible transport rather than a new API.
 *
 * ── Raw fetch, no SDK ────────────────────────────────────────────────────────
 *
 * Deliberate. The three targets above disagree about auth and URL but agree about the
 * body, which is exactly the case an SDK abstracts *away from* — the `openai` package
 * needs different construction per target and pulls in a dependency to send one POST.
 * Node's global `fetch` sends the same body to all three.
 *
 * ── The safety contract is identical to Claude's ─────────────────────────────
 *
 * `tool_choice: 'required'` forces a call, so prose cannot come back. If a server ignores
 * that — some self-hosted ones do — the response arrives with no `tool_calls` and this
 * adapter FAILS rather than looking in `message.content` for something SQL-shaped. That
 * fallback is the whole reason ADR-04 exists, and it is not implemented here on purpose.
 */

/** How to reach one endpoint. The only thing that varies between the three targets. */
export interface OpenAiTransport {
	/** Fully-formed chat-completions URL, api-version query included where required. */
	url: string;
	headers: Record<string, string>;
	/**
	 * The `model` field of the request body.
	 *
	 * Azure routes by deployment in the URL and ignores this, but rejects the request if
	 * it is missing, so it is always sent — set to the deployment name for Azure.
	 */
	model: string;
	/** For logs and the boot report. Never contains a credential. */
	label: string;
}

const TOOLS = [
	{
		type: 'function',
		function: {
			name: SQL_TOOL,
			description: SQL_TOOL_DESCRIPTION,
			parameters: SQL_TOOL_SCHEMA,
			// OpenAI's equivalent of Anthropic's `strict: true` — constrained decoding
			// against the schema, so a malformed proposal is rejected at the API boundary.
			// Servers that do not implement it ignore the flag; the contract still holds
			// because `interpretToolCall` re-checks every field it depends on.
			strict: true
		}
	},
	{
		type: 'function',
		function: {
			name: DECLINE_TOOL,
			description: DECLINE_TOOL_DESCRIPTION,
			parameters: DECLINE_TOOL_SCHEMA,
			strict: true
		}
	}
];

interface ChatCompletionResponse {
	choices?: Array<{
		finish_reason?: string;
		message?: {
			content?: string | null;
			tool_calls?: Array<{
				function?: {name?: string; arguments?: string};
			}>;
		};
	}>;
	error?: {message?: string; code?: string};
}

export class OpenAiProvider implements LlmProvider {
	constructor(
		private readonly transport: OpenAiTransport,
		private readonly temperature: number | null,
		private readonly timeoutMs = 60_000
	) {}

	name(): string {
		return this.transport.label;
	}

	async generate(question: string): Promise<ProviderResponse> {
		const body: Record<string, unknown> = {
			model: this.transport.model,
			messages: [
				{role: 'system', content: buildSystemPrompt()},
				{role: 'user', content: buildUserPrompt(question)}
			],
			tools: TOOLS,
			// THE contract. Forces a tool call, so free prose cannot be returned at all.
			tool_choice: 'required',
			// Never streamed: the gate needs the whole statement before it can decide
			// anything, so there is nothing a partial response could be used for.
			stream: false
		};

		/**
		 * Temperature is OMITTED when null rather than defaulted.
		 *
		 * Reasoning models (o-series, and newer families) reject the parameter outright
		 * with a 400, so a hard-coded `temperature: 0` would make this adapter silently
		 * incompatible with exactly the models most likely to be deployed next.
		 * `LLM_TEMPERATURE=` (empty) omits it.
		 */
		if (this.temperature !== null) body.temperature = this.temperature;

		const payload = await this.post(body);

		const choice = payload.choices?.[0];
		const toolCall = choice?.message?.tool_calls?.[0];

		/**
		 * No tool call despite `tool_choice: 'required'`. Contract violation.
		 *
		 * `message.content` may well hold a perfectly good SELECT here. It is not read.
		 * Reaching into prose for something SQL-shaped is the parsing problem the
		 * structured contract exists to remove, and a self-hosted server that ignores
		 * `tool_choice` is precisely the case where that prose is least trustworthy.
		 */
		if (!toolCall?.function?.name) {
			throw new ProviderUnavailableError(
				`Provider returned no tool call (finish_reason: ${choice?.finish_reason ?? 'unknown'}).`
			);
		}

		// Arguments arrive as a JSON *string* here, unlike Anthropic's decoded object.
		let args: unknown;
		try {
			args = JSON.parse(toolCall.function.arguments ?? '{}');
		} catch {
			throw new ProviderUnavailableError('Provider tool arguments were not valid JSON.');
		}

		return interpretToolCall(toolCall.function.name, args);
	}

	/** One POST, with a timeout and error text that never reaches a client. */
	private async post(body: unknown): Promise<ChatCompletionResponse> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);

		let response: Response;
		try {
			response = await fetch(this.transport.url, {
				method: 'POST',
				headers: {'Content-Type': 'application/json', ...this.transport.headers},
				body: JSON.stringify(body),
				signal: controller.signal
			});
		} catch (error: unknown) {
			// An abort and a DNS failure are the same outcome for the caller. The
			// distinction is kept for the audit log, which is where it is useful.
			const aborted = error instanceof Error && error.name === 'AbortError';
			throw new ProviderUnavailableError(aborted ? 'Provider timed out.' : 'Provider unreachable.');
		} finally {
			clearTimeout(timer);
		}

		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new ProviderUnavailableError('Provider credential rejected.');
			}
			if (response.status === 429) {
				throw new ProviderUnavailableError('Provider rate limit reached.');
			}

			/**
			 * The provider's own `error.message` — and ONLY that field — is recorded.
			 *
			 * It goes to `query_log.rejection_reason`, never to the client: the orchestrator
			 * replaces it with one fixed sentence and the error renderer strips the rest.
			 * Without it the audit record said "Provider returned 400." and nothing else,
			 * which documents that something failed while discarding the only part that
			 * says why (defect D-33).
			 *
			 * The whole body is deliberately NOT taken. Some servers echo the request back
			 * inside their error, and the request carries the schema catalogue — a needless
			 * thing to copy into a table, at a length nobody will read. One field, truncated.
			 */
			const detail = await response
				.json()
				.then(body => {
					const message = (body as ChatCompletionResponse)?.error?.message;
					return typeof message === 'string' ? ` ${message.slice(0, 400)}` : '';
				})
				.catch(() => '');

			throw new ProviderUnavailableError(`Provider returned ${response.status}.${detail}`);
		}

		try {
			return (await response.json()) as ChatCompletionResponse;
		} catch {
			throw new ProviderUnavailableError('Provider returned a malformed response body.');
		}
	}
}

/** OpenAI proper, or any server speaking the same wire format at a custom base URL. */
export function openAiTransport(apiKey: string, model: string, baseUrl: string): OpenAiTransport {
	const base = baseUrl.replace(/\/+$/, '');
	return {
		url: `${base}/chat/completions`,
		// Bearer even when the key is empty — self-hosted servers commonly want no auth,
		// and an empty bearer is what they expect rather than an absent header.
		headers: {Authorization: `Bearer ${apiKey}`},
		model,
		label: `openai:${model}`
	};
}

/**
 * Azure OpenAI: the model is a **deployment name in the path**, the key is `api-key`, and
 * `api-version` is mandatory.
 *
 * The deployment name is chosen by whoever deployed the model and need not match any
 * published model id — which is why it is configured separately from `LLM_MODEL` rather
 * than derived from it.
 */
export function azureOpenAiTransport(
	apiKey: string,
	endpoint: string,
	deployment: string,
	apiVersion: string
): OpenAiTransport {
	const base = endpoint.replace(/\/+$/, '');
	return {
		url: `${base}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
		headers: {'api-key': apiKey},
		model: deployment,
		label: `azure-openai:${deployment}`
	};
}
