import {ChartType} from '../_typings/types';

/**
 * The LLM provider interface (ADR-05, NFR-16).
 *
 * The provider is the fastest-moving and least stable dependency in the system, so it
 * sits behind an interface with two implementations. This is what makes the model layer
 * replaceable without touching validation, execution or presentation — and what lets
 * the whole pipeline run offline, deterministically, at zero cost.
 */

/**
 * What the model proposes. UNTRUSTED — every field of it.
 *
 * `sql` goes to the validation gate before any execution decision. `chartType` is
 * reconciled against the actual result shape (ADR-08) because the model recommends a
 * chart before it has seen a single row. `explanation` is shown to the user and is the
 * main way they check the system understood the question they meant to ask.
 */
export interface SqlProposal {
	kind: 'sql';
	sql: string;
	chartType: ChartType;
	explanation: string;
}

/**
 * The model declining (FR-10).
 *
 * A second tool exists so "I cannot answer this" is a STRUCTURED outcome rather than
 * prose that has to be recognised. Without it the model's only way to decline is free
 * text, which the contract treats as malformed — turning an honest, correct refusal
 * into an error the user cannot distinguish from a bug.
 */
export interface DeclineProposal {
	kind: 'decline';
	reason: string;
}

export type ProviderResponse = SqlProposal | DeclineProposal;

export interface LlmProvider {
	name(): string;
	/** Throws ProviderUnavailableError on any transport or contract failure. */
	generate(question: string): Promise<ProviderResponse>;
}

/**
 * The provider failed. Distinct from "the model declined" — one is an outage, the other
 * is an answer. NFR-12 requires them to degrade differently: an outage is a 503 that
 * says the dashboard still works; a decline is a 400 that says rephrase.
 */
export class ProviderUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProviderUnavailableError';
	}
}
