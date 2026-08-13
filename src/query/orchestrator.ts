import {BaseErrors} from '../_services/errorService';
import {AuthenticatedUser, ChartType} from '../_typings/types';
import {ExecutionError, ExecutionResult, executeValidatedSql} from '../guard/executor';
import {validateSql} from '../guard/validator';
import {getProvider, ProviderUnavailableError} from '../llm';
import {Audit} from './auditRecorder';
import {selectChartType} from './chartSelector';

/**
 * The six-stage pipeline (docs/02 §6.1, FR-08 – FR-17).
 *
 *   1 intake            validated at the route boundary by zod
 *   2 context           schema catalogue + metric glossary, never table contents
 *   3 generate          UNTRUSTED output from here on
 *   4 VALIDATE          the security boundary — nothing downstream re-checks
 *   5 guarded execute   read-only role, statement timeout, row ceiling
 *   6 shape             chart reconciled against the actual result
 *
 * Stages 1–3 may fail arbitrarily without compromising safety, PROVIDED stage 4 holds.
 * That is the whole architecture in one sentence, and it is why this file contains no
 * cleverness: its job is to hand stage 3's output to stage 4 and do nothing with it
 * otherwise.
 *
 * ── Every exit audits ────────────────────────────────────────────────────────
 *
 * There is no `return` in this function that is not preceded by an audit write. The
 * failure paths are the records that matter (ADR-07), so they are written first and the
 * response is shaped from what was written.
 */

export interface QueryOutcome {
	queryId: number;
	question: string;
	explanation: string;
	chartType: ChartType | null;
	columns: ExecutionResult['columns'];
	rows: ExecutionResult['rows'];
	rowCount: number;
	durationMs: number;
	truncated: boolean;
	/** ANALYST-only. Stripped by `projectForRole` before serialisation (FR-05). */
	generatedSql: string | null;
	failedCheck: string | null;
	rejectionReason: string | null;
}

/** A refusal the caller turns into a response. Carries the audit id for the history view. */
export interface QueryRefusal {
	refused: true;
	queryId: number;
	/** The ONE fixed sentence the user sees. Never the reason. */
	userMessage: string;
	httpStatus: number;
}

export type QueryResult = QueryOutcome | QueryRefusal;

export function isRefusal(result: QueryResult): result is QueryRefusal {
	return (result as QueryRefusal).refused === true;
}

const REFUSED_MESSAGE = BaseErrors.QuestionRefused.toJSON().message as string;
const UNAVAILABLE_MESSAGE = BaseErrors.ProviderUnavailable.toJSON().message as string;
const TIMEOUT_MESSAGE = BaseErrors.QueryTimedOut.toJSON().message as string;

/**
 * NOTE there is no `knex` parameter. Auditing deliberately runs on its own connection so
 * a record cannot be rolled back by the request it documents (defect D-14) — and taking
 * a transaction here would be an invitation to re-couple them. Execution uses the
 * read-only connection, which is likewise not the caller's to supply.
 */
export async function answerQuestion(user: AuthenticatedUser, question: string): Promise<QueryResult> {
	const trimmed = question.trim();

	// ── Stages 2 & 3: context and generation ─────────────────────────────────
	let proposal;
	try {
		proposal = await getProvider().generate(trimmed);
	} catch (error: unknown) {
		/**
		 * NFR-12. The provider is down; the dashboard and history are not, because they
		 * are hand-written SQL that never touched it. A 503 rather than a 400 — this is
		 * an outage, and telling the user to rephrase would be a lie.
		 */
		const reason = error instanceof ProviderUnavailableError ? error.message : 'Provider call failed.';
		const queryId = await Audit.record({
			userId: user.id,
			question: trimmed,
			generatedSql: null,
			validationStatus: 'REJECTED',
			rejectionReason: reason,
			failedCheck: 'provider_unavailable',
			executionStatus: 'PROVIDER_UNAVAILABLE',
			rowCount: null,
			durationMs: null,
			chartType: null
		});
		return {refused: true, queryId, userMessage: UNAVAILABLE_MESSAGE, httpStatus: 503};
	}

	if (proposal.kind === 'decline') {
		/**
		 * The model declined. This is a CORRECT answer, not a failure — and it is audited
		 * as REJECTED/NOT_ATTEMPTED so the history shows the question was refused rather
		 * than silently dropped. The interface displays blocked questions deliberately
		 * (docs §8.3): making the control visible is what builds warranted trust.
		 */
		const queryId = await Audit.record({
			userId: user.id,
			question: trimmed,
			generatedSql: null,
			validationStatus: 'REJECTED',
			rejectionReason: proposal.reason,
			failedCheck: 'provider_declined',
			executionStatus: 'NOT_ATTEMPTED',
			rowCount: null,
			durationMs: null,
			chartType: null
		});
		return {refused: true, queryId, userMessage: REFUSED_MESSAGE, httpStatus: 400};
	}

	// ── Stage 4: THE GATE ────────────────────────────────────────────────────
	const validation = await validateSql(proposal.sql);

	if (!validation.permitted || !validation.normalisedSql) {
		/**
		 * The full reason and the failed check go to the audit log. The user gets one
		 * fixed sentence — a specific message would tell someone probing the boundary
		 * exactly which of the ten checks they tripped, and therefore how to route around
		 * it (CLAUDE.md §4 rule 7, TD-Q).
		 *
		 * The rejected SQL IS stored: it is the evidence, and an investigator needs to see
		 * what the model actually proposed.
		 */
		const queryId = await Audit.record({
			userId: user.id,
			question: trimmed,
			generatedSql: proposal.sql,
			validationStatus: 'REJECTED',
			rejectionReason: validation.reason,
			failedCheck: validation.failedCheck,
			executionStatus: 'NOT_ATTEMPTED',
			rowCount: null,
			durationMs: null,
			chartType: null
		});
		return {refused: true, queryId, userMessage: REFUSED_MESSAGE, httpStatus: 400};
	}

	// ── Stage 5: guarded execution ───────────────────────────────────────────
	let execution: ExecutionResult;
	try {
		execution = await executeValidatedSql(validation.normalisedSql);
	} catch (error: unknown) {
		const executionError = error instanceof ExecutionError ? error : null;
		const timedOut = executionError?.timedOut ?? false;

		const queryId = await Audit.record({
			userId: user.id,
			question: trimmed,
			generatedSql: validation.normalisedSql,
			validationStatus: 'PERMITTED',
			// The driver's message — which names columns and constraints — is persisted
			// HERE and nowhere else. It never reaches the client (TH-10, test D-11).
			rejectionReason: executionError?.message ?? 'Execution failed',
			failedCheck: null,
			executionStatus: timedOut ? 'TIMEOUT' : 'ERROR',
			rowCount: null,
			durationMs: null,
			chartType: null
		});

		return {
			refused: true,
			queryId,
			userMessage: timedOut ? TIMEOUT_MESSAGE : REFUSED_MESSAGE,
			httpStatus: 400
		};
	}

	// ── Stage 6: shape ───────────────────────────────────────────────────────
	// The model's hint is reconciled against what actually came back (ADR-08).
	const chartType = selectChartType(proposal.chartType, execution);

	const queryId = await Audit.record({
		userId: user.id,
		question: trimmed,
		generatedSql: validation.normalisedSql,
		validationStatus: 'PERMITTED',
		rejectionReason: null,
		failedCheck: null,
		executionStatus: 'SUCCESS',
		rowCount: execution.rowCount,
		durationMs: execution.durationMs,
		chartType
	});

	return {
		queryId,
		question: trimmed,
		explanation: proposal.explanation,
		chartType,
		columns: execution.columns,
		rows: execution.rows,
		rowCount: execution.rowCount,
		durationMs: execution.durationMs,
		truncated: execution.truncated,
		generatedSql: validation.normalisedSql,
		failedCheck: null,
		rejectionReason: null
	};
}
