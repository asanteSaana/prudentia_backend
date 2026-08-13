import {Constants} from '../_services/_constants';
import {ClaudeProvider} from './claudeProvider';
import {azureOpenAiTransport, OpenAiProvider, openAiTransport} from './openAiProvider';
import {StubProvider} from './stubProvider';
import {LlmProvider} from './types';

export * from './types';
export {ClaudeProvider} from './claudeProvider';
export {OpenAiProvider, azureOpenAiTransport, openAiTransport} from './openAiProvider';
export {StubProvider, FIXTURES} from './stubProvider';
export {buildSystemPrompt, buildUserPrompt} from './contextAssembler';
export {interpretToolCall, SQL_TOOL, DECLINE_TOOL} from './toolContract';

let cached: LlmProvider | null = null;

/**
 * Provider selection (ADR-05, NFR-16). The ONLY place a concrete provider is chosen.
 *
 * ── Supported values of LLM_PROVIDER ─────────────────────────────────────────
 *
 *   claude          Anthropic. `ANTHROPIC_API_KEY`, `LLM_MODEL`
 *   openai          OpenAI, or any OpenAI-compatible server via `OPENAI_BASE_URL`
 *                   (vLLM, Ollama's OpenAI shim, a self-hosted gateway).
 *                   `OPENAI_API_KEY`, `LLM_MODEL`
 *   azure-openai    An Azure OpenAI deployment. `AZURE_OPENAI_ENDPOINT`,
 *                   `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`,
 *                   `AZURE_OPENAI_API_VERSION`
 *   stub            Deterministic fixtures. No network, no cost
 *
 * ── Why swapping the model changes nothing else ──────────────────────────────
 *
 * Every provider is asked for the same two tools with the same descriptions and schemas
 * (`toolContract.ts`), and every response is interpreted by the same function. So the
 * provider is genuinely the only variable: the gate, the executor, the audit trail and
 * the presentation layer neither know nor can be affected by which vendor answered.
 *
 * That is also what makes a provider comparison meaningful — the alternative, where each
 * adapter carries its own prompt wording, would make any accuracy difference between two
 * models uninterpretable, because the prompt would have changed too.
 *
 * ── Falling back to the stub is deliberate, and so is the warning ────────────
 *
 * A missing or revoked credential degrades the system to deterministic answers on the
 * demonstration corpus instead of taking the query endpoint down (NFR-12). The dashboard
 * and history are hand-written SQL and never depended on a provider at all.
 *
 * The warning matters as much as the fallback: a system quietly serving fixtures while
 * the operator believes it is live is worse than one that is plainly down.
 */
export function getProvider(): LlmProvider {
	if (cached) return cached;
	cached = buildProvider();
	return cached;
}

function buildProvider(): LlmProvider {
	const selected = Constants.LLM_PROVIDER.trim().toLowerCase();

	switch (selected) {
		case 'stub':
			return new StubProvider();

		case 'claude':
		case 'anthropic':
			if (!Constants.ANTHROPIC_API_KEY) {
				return fallback('LLM_PROVIDER=claude but ANTHROPIC_API_KEY is not set.');
			}
			return new ClaudeProvider(Constants.ANTHROPIC_API_KEY, Constants.LLM_MODEL);

		case 'openai':
			if (!Constants.OPENAI_API_KEY && !Constants.OPENAI_BASE_URL_IS_CUSTOM) {
				// A custom base URL is allowed to be unauthenticated — a self-hosted vLLM
				// or Ollama shim on a private network usually is. api.openai.com is not.
				return fallback('LLM_PROVIDER=openai but OPENAI_API_KEY is not set.');
			}
			return new OpenAiProvider(
				openAiTransport(Constants.OPENAI_API_KEY ?? '', Constants.LLM_MODEL, Constants.OPENAI_BASE_URL),
				Constants.LLM_TEMPERATURE
			);

		case 'azure-openai':
		case 'azure_openai':
		case 'azure': {
			const missing = [
				!Constants.AZURE_OPENAI_ENDPOINT && 'AZURE_OPENAI_ENDPOINT',
				!Constants.AZURE_OPENAI_API_KEY && 'AZURE_OPENAI_API_KEY',
				!Constants.AZURE_OPENAI_DEPLOYMENT && 'AZURE_OPENAI_DEPLOYMENT'
			].filter(Boolean);

			if (missing.length > 0) {
				return fallback(`LLM_PROVIDER=azure-openai but ${missing.join(', ')} not set.`);
			}

			return new OpenAiProvider(
				azureOpenAiTransport(
					Constants.AZURE_OPENAI_API_KEY as string,
					Constants.AZURE_OPENAI_ENDPOINT as string,
					Constants.AZURE_OPENAI_DEPLOYMENT as string,
					Constants.AZURE_OPENAI_API_VERSION
				),
				Constants.LLM_TEMPERATURE
			);
		}

		default:
			/**
			 * An UNRECOGNISED value falls back rather than throwing — but loudly.
			 *
			 * A typo in `LLM_PROVIDER` should not stop the service, because the dashboard,
			 * history and the entire security boundary are unaffected by it. It must not be
			 * silent either, because "why are all the answers canned?" is otherwise a long
			 * afternoon.
			 */
			return fallback(`LLM_PROVIDER=${Constants.LLM_PROVIDER} is not a provider this build knows.`);
	}
}

function fallback(reason: string): LlmProvider {
	console.warn(`${reason} Falling back to the deterministic stub provider — answers come from fixtures, not a model.`);
	return new StubProvider();
}

/**
 * One line at boot naming the provider that is actually live (see `src/index.ts`).
 *
 * GhanaCard prints which rate-limit store is active for the same reason: a fallback that
 * announces itself is a degraded system, and a fallback that does not is an outage nobody
 * has noticed yet.
 */
export function describeProvider(): string {
	return getProvider().name();
}

/** Test seam. Never called in production. */
export function resetProvider(): void {
	cached = null;
}
