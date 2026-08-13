/* eslint-disable @typescript-eslint/no-require-imports --
 * `require` is load-bearing here, not laziness. `Constants` reads `process.env` once at
 * module load, so testing provider selection means re-importing the module graph with a
 * different environment — and `jest.isolateModules` takes a SYNCHRONOUS callback, which
 * `import()` cannot satisfy. The file-reading `require`s below serve the same purpose.
 */
/**
 * Provider selection (ADR-05, NFR-16).
 *
 * `Constants` reads `process.env` once at module load, so each case re-imports the module
 * graph with the environment it wants. `jest.isolateModules` is what makes that possible
 * without the cached provider from one case leaking into the next.
 *
 * What is being asserted throughout: **a misconfiguration degrades, it does not crash,
 * and it is never silent.** The dashboard, the history and the entire security boundary
 * are unaffected by which model answered — so stopping the service over a missing key
 * would take down three working things to punish one broken one. But an operator who
 * believes they are talking to Azure while fixtures are served is worse off than one
 * whose service is plainly down, so every fallback warns.
 */

function withEnv<T>(env: Record<string, string | undefined>, run: (llm: typeof import('../index')) => T): T {
	const saved = {...process.env};
	Object.assign(process.env, env);
	try {
		let result!: T;
		jest.isolateModules(() => {
			result = run(require('../index'));
		});
		return result;
	} finally {
		process.env = saved;
	}
}

const CLEAR = {
	ANTHROPIC_API_KEY: undefined,
	OPENAI_API_KEY: undefined,
	OPENAI_BASE_URL: undefined,
	AZURE_OPENAI_ENDPOINT: undefined,
	AZURE_OPENAI_API_KEY: undefined,
	AZURE_OPENAI_DEPLOYMENT: undefined
};

let warn: jest.SpyInstance;

beforeEach(() => {
	warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
	warn.mockRestore();
});

describe('selecting a provider', () => {
	it('builds the stub when asked for it, with no warning — it is a supported mode, not a failure', () => {
		const name = withEnv({...CLEAR, LLM_PROVIDER: 'stub'}, llm => llm.getProvider().name());

		expect(name).toBe('stub');
		expect(warn).not.toHaveBeenCalled();
	});

	it('builds Claude with the configured model', () => {
		const name = withEnv({...CLEAR, LLM_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'sk-x', LLM_MODEL: 'claude-opus-5'}, llm =>
			llm.getProvider().name()
		);

		expect(name).toBe('claude:claude-opus-5');
	});

	it('builds OpenAI with the configured model', () => {
		const name = withEnv({...CLEAR, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x', LLM_MODEL: 'gpt-4o-mini'}, llm =>
			llm.getProvider().name()
		);

		expect(name).toBe('openai:gpt-4o-mini');
	});

	it('builds Azure OpenAI from endpoint + deployment', () => {
		const name = withEnv(
			{
				...CLEAR,
				LLM_PROVIDER: 'azure-openai',
				AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com',
				AZURE_OPENAI_API_KEY: 'key',
				AZURE_OPENAI_DEPLOYMENT: 'gpt-4o-mini'
			},
			llm => llm.getProvider().name()
		);

		expect(name).toBe('azure-openai:gpt-4o-mini');
	});

	/**
	 * A self-hosted OpenAI-compatible server on a private network commonly has no auth at
	 * all. Demanding a key there would make the one deployment shape this refactor exists
	 * to support impossible to configure.
	 */
	it('allows a custom base URL with no key, but not api.openai.com with no key', () => {
		const selfHosted = withEnv(
			{...CLEAR, LLM_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://localhost:8000/v1', LLM_MODEL: 'llama-3.1'},
			llm => llm.getProvider().name()
		);
		expect(selfHosted).toBe('openai:llama-3.1');

		const unauthenticatedOpenAi = withEnv({...CLEAR, LLM_PROVIDER: 'openai'}, llm => llm.getProvider().name());
		expect(unauthenticatedOpenAi).toBe('stub');
	});
});

describe('misconfiguration degrades to the stub, loudly', () => {
	it.each([
		['claude', {LLM_PROVIDER: 'claude'}, /ANTHROPIC_API_KEY/],
		['openai', {LLM_PROVIDER: 'openai'}, /OPENAI_API_KEY/],
		['azure-openai', {LLM_PROVIDER: 'azure-openai'}, /AZURE_OPENAI_ENDPOINT/],
		['an unknown provider', {LLM_PROVIDER: 'gemini'}, /not a provider this build knows/]
	])('%s without credentials', (_label, env, expected) => {
		const name = withEnv({...CLEAR, ...env}, llm => llm.getProvider().name());

		expect(name).toBe('stub');
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(expected as RegExp));
		// The warning has to say what actually happens, or it reads as a soft note.
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/fixtures, not a model/i));
	});

	it('names every missing Azure setting at once, not just the first', () => {
		withEnv({...CLEAR, LLM_PROVIDER: 'azure-openai', AZURE_OPENAI_ENDPOINT: 'https://x'}, llm =>
			llm.getProvider().name()
		);

		const message = warn.mock.calls[0][0] as string;
		expect(message).toContain('AZURE_OPENAI_API_KEY');
		expect(message).toContain('AZURE_OPENAI_DEPLOYMENT');
		expect(message).not.toContain('AZURE_OPENAI_ENDPOINT');
	});
});

describe('the provider is a genuine swap and nothing more', () => {
	/**
	 * The point of the refactor. If two providers were asked for different tools, or
	 * their responses were interpreted by different code, then "swap the model" would
	 * quietly also mean "swap the prompt and the parser" — and any accuracy difference
	 * measured between them would be uninterpretable.
	 */
	it('asks every provider for the same two tools with the same wording', () => {
		const {SQL_TOOL, DECLINE_TOOL} = require('../toolContract');
		const claudeSource = require('fs').readFileSync(require.resolve('../claudeProvider'), 'utf8');
		const openAiSource = require('fs').readFileSync(require.resolve('../openAiProvider'), 'utf8');

		// Neither adapter may define its own tool names, descriptions or schemas.
		for (const source of [claudeSource, openAiSource]) {
			expect(source).toContain("from './toolContract'");
			expect(source).not.toMatch(/name:\s*'propose_sql'/);
			expect(source).toContain('interpretToolCall');
		}

		expect(SQL_TOOL).toBe('propose_sql');
		expect(DECLINE_TOOL).toBe('decline');
	});
});
