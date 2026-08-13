import {azureOpenAiTransport, OpenAiProvider, openAiTransport} from '../openAiProvider';
import {ProviderUnavailableError} from '../types';

/**
 * The OpenAI-compatible adapter (ADR-04, ADR-05).
 *
 * The tests that matter here are not the happy paths — those are one field access. They
 * are the ones asserting that the adapter **fails** where it would be convenient to
 * succeed, because those are the properties the security argument rests on:
 *
 *   · a response with no tool call is a failure, however good the prose looks
 *   · a provider error body is recorded for the LOG but never handed to the client
 *
 * A future maintainer pointing this at a self-hosted server that ignores `tool_choice`
 * will be tempted to add a prose fallback. These tests are the reason not to.
 */

const originalFetch = global.fetch;

/** Captures the request so the contract sent on the wire can be asserted, not assumed. */
function mockFetch(response: unknown, status = 200): jest.Mock {
	const mock = jest.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => response
	})) as unknown as jest.Mock;
	global.fetch = mock as unknown as typeof fetch;
	return mock;
}

function toolCallResponse(name: string, args: unknown) {
	return {
		choices: [
			{
				finish_reason: 'tool_calls',
				message: {content: null, tool_calls: [{function: {name, arguments: JSON.stringify(args)}}]}
			}
		]
	};
}

const transport = openAiTransport('key-123', 'gpt-4o-mini', 'https://api.openai.com/v1');

afterEach(() => {
	global.fetch = originalFetch;
	jest.restoreAllMocks();
});

describe('the request carries the contract', () => {
	it('forces a tool call, so prose cannot be returned at all', async () => {
		const fetchMock = mockFetch(toolCallResponse('propose_sql', {sql: 'SELECT 1', chart_type: 'kpi', explanation: 'x'}));

		await new OpenAiProvider(transport, 0).generate('anything');

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.tool_choice).toBe('required');
		expect(body.tools.map((tool: any) => tool.function.name).sort()).toEqual(['decline', 'propose_sql']);
	});

	it('omits temperature entirely when it is null, because reasoning models reject the field', async () => {
		const fetchMock = mockFetch(toolCallResponse('decline', {reason: 'no'}));

		await new OpenAiProvider(transport, null).generate('anything');

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect('temperature' in body).toBe(false);
	});

	it('sends temperature when one is configured', async () => {
		const fetchMock = mockFetch(toolCallResponse('decline', {reason: 'no'}));

		await new OpenAiProvider(transport, 0).generate('anything');

		expect(JSON.parse(fetchMock.mock.calls[0][1].body).temperature).toBe(0);
	});
});

describe('interpreting the response', () => {
	it('returns a proposal from the sql tool', async () => {
		mockFetch(
			toolCallResponse('propose_sql', {
				sql: 'SELECT COUNT(*) FROM claims',
				chart_type: 'kpi',
				explanation: 'Total claims.'
			})
		);

		const result = await new OpenAiProvider(transport, 0).generate('how many claims?');

		expect(result).toEqual({
			kind: 'sql',
			sql: 'SELECT COUNT(*) FROM claims',
			chartType: 'kpi',
			explanation: 'Total claims.'
		});
	});

	it('returns a decline from the decline tool', async () => {
		mockFetch(toolCallResponse('decline', {reason: 'Not in the schema.'}));

		const result = await new OpenAiProvider(transport, 0).generate('who is the CEO?');

		expect(result).toEqual({kind: 'decline', reason: 'Not in the schema.'});
	});

	/**
	 * THE test. A server that ignores `tool_choice` returns a perfectly usable SELECT in
	 * `message.content`. Reading it would "work" — and would reintroduce exactly the
	 * heuristic extraction ADR-04 exists to remove, at the one moment the output is least
	 * trustworthy.
	 */
	it('FAILS rather than reading SQL out of prose when no tool was called', async () => {
		mockFetch({
			choices: [{finish_reason: 'stop', message: {content: 'SELECT * FROM claims', tool_calls: undefined}}]
		});

		const attempt = new OpenAiProvider(transport, 0).generate('how many claims?');

		await expect(attempt).rejects.toThrow(ProviderUnavailableError);
		await expect(attempt).rejects.toThrow(/no tool call/i);
		// And specifically: the prose is not smuggled into the error either.
		await expect(attempt).rejects.not.toThrow(/SELECT \* FROM claims/);
	});

	it('fails on an unknown tool rather than guessing which one was meant', async () => {
		mockFetch(toolCallResponse('run_sql', {sql: 'SELECT 1'}));

		await expect(new OpenAiProvider(transport, 0).generate('q')).rejects.toThrow(/unknown tool/i);
	});

	it('fails when the proposal omits the sql field, rather than defaulting it', async () => {
		mockFetch(toolCallResponse('propose_sql', {chart_type: 'bar', explanation: 'x'}));

		await expect(new OpenAiProvider(transport, 0).generate('q')).rejects.toThrow(/omitted the SQL field/i);
	});

	it('fails on unparseable tool arguments', async () => {
		mockFetch({
			choices: [{message: {tool_calls: [{function: {name: 'propose_sql', arguments: '{not json'}}]}}]
		});

		await expect(new OpenAiProvider(transport, 0).generate('q')).rejects.toThrow(/not valid JSON/i);
	});

	/**
	 * The hint is untrusted and reconciled against the real result shape downstream
	 * (ADR-08), so a bad value must cost a presentation choice, not an answer.
	 */
	it('degrades an unrecognised chart_type to table instead of failing', async () => {
		mockFetch(toolCallResponse('propose_sql', {sql: 'SELECT 1', chart_type: 'pie', explanation: 'x'}));

		const result = await new OpenAiProvider(transport, 0).generate('q');

		expect(result).toMatchObject({kind: 'sql', chartType: 'table'});
	});
});

describe('transport failures are classified for the audit log', () => {
	/**
	 * ── What changed here, and why it is not a widened test ────────────────
	 *
	 * This block used to assert that the provider's error text was DISCARDED, under the
	 * name "never repeat the provider back to the caller". That name described a real
	 * requirement and the assertion tested the wrong channel for it.
	 *
	 * `ProviderUnavailableError.message` is the AUDIT LOG channel: the orchestrator writes
	 * it to `query_log.rejection_reason` and replaces it with one fixed sentence for the
	 * response. So the old assertion was not protecting the client at all — it was
	 * throwing away the diagnostic an investigator needs, and the thing it appeared to
	 * guarantee was in fact tested nowhere (defect D-33).
	 *
	 * The client-side guarantee now has its own test, at the layer where it is actually
	 * decided: `pipeline.test.ts`, "a provider failure tells the user nothing about the
	 * provider". This block asserts the complementary half — that the log is diagnostic.
	 */
	it.each([
		[401, /credential rejected/i],
		[403, /credential rejected/i],
		[429, /rate limit/i]
	])('maps HTTP %s to a fixed classification', async (status, expected) => {
		mockFetch({error: {message: 'anything'}}, status as number);

		await expect(new OpenAiProvider(transport, 0).generate('q')).rejects.toThrow(expected as RegExp);
	});

	it("records the provider's own explanation, because 'returned 400' is not a diagnosis", async () => {
		mockFetch({error: {message: "Unsupported parameter: 'output_config'"}}, 400);

		const attempt = new OpenAiProvider(transport, 0).generate('q');

		await expect(attempt).rejects.toThrow(/returned 400/);
		await expect(attempt).rejects.toThrow(/output_config/);
	});

	it('takes only the error message, never the whole body', async () => {
		// Some servers echo the request inside their error, and the request carries the
		// schema catalogue — a needless thing to copy into a table at a length nobody reads.
		mockFetch(
			{error: {message: 'Bad request'}, request_echo: 'the entire schema catalogue goes here'},
			400
		);

		await expect(new OpenAiProvider(transport, 0).generate('q')).rejects.not.toThrow(/schema catalogue/);
	});

	it('survives an error body that is not JSON at all', async () => {
		global.fetch = jest.fn(async () => ({
			ok: false,
			status: 502,
			json: async () => {
				throw new Error('not json');
			}
		})) as unknown as typeof fetch;

		await expect(new OpenAiProvider(transport, 0).generate('q')).rejects.toThrow(/returned 502/);
	});

	it('reports an unreachable provider without leaking the transport error', async () => {
		global.fetch = jest.fn(async () => {
			throw new Error('getaddrinfo ENOTFOUND internal-host.corp');
		}) as unknown as typeof fetch;

		const attempt = new OpenAiProvider(transport, 0).generate('q');

		await expect(attempt).rejects.toThrow(/unreachable/i);
		await expect(attempt).rejects.not.toThrow(/internal-host/);
	});

	it('reports a timeout distinctly, because the two need different operator responses', async () => {
		global.fetch = jest.fn(async () => {
			const error = new Error('aborted');
			error.name = 'AbortError';
			throw error;
		}) as unknown as typeof fetch;

		await expect(new OpenAiProvider(transport, 0).generate('q')).rejects.toThrow(/timed out/i);
	});
});

describe('transports', () => {
	it('builds the OpenAI URL and bearer auth', () => {
		const built = openAiTransport('sk-test', 'gpt-4o-mini', 'https://api.openai.com/v1/');

		expect(built.url).toBe('https://api.openai.com/v1/chat/completions');
		expect(built.headers.Authorization).toBe('Bearer sk-test');
		expect(built.model).toBe('gpt-4o-mini');
	});

	/**
	 * Azure routes by DEPLOYMENT in the path, authenticates with `api-key` rather than a
	 * bearer token, and requires `api-version`. Getting any of the three wrong produces a
	 * 404 that looks like a missing model, which is a slow thing to debug — hence a test.
	 */
	it('builds the Azure deployment URL and api-key auth', () => {
		const built = azureOpenAiTransport('azure-key', 'https://my-res.openai.azure.com/', 'gpt-4o-mini', '2024-10-21');

		expect(built.url).toBe(
			'https://my-res.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21'
		);
		expect(built.headers['api-key']).toBe('azure-key');
		expect(built.headers.Authorization).toBeUndefined();
		// Azure ignores the body's `model` but rejects the request without it.
		expect(built.model).toBe('gpt-4o-mini');
	});

	it('names the provider without ever including the credential', () => {
		expect(new OpenAiProvider(openAiTransport('sk-secret', 'gpt-4o', 'https://api.openai.com/v1'), 0).name()).toBe(
			'openai:gpt-4o'
		);
		expect(
			new OpenAiProvider(
				azureOpenAiTransport('secret', 'https://x.openai.azure.com', 'prod-gpt', '2024-10-21'),
				0
			).name()
		).toBe('azure-openai:prod-gpt');
	});
});
