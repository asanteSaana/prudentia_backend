import {Response} from 'express';
import {projectForRole, projectListForRole} from '../auth/roleView';
import {createError} from '../_services/errorService';
import {CustomRequest} from '../_typings/types';
import {queryRateLimiter} from '../rateLimiters';
import {route} from '../routesCreator';
import {Audit} from './auditRecorder';
import {answerQuestion, isRefusal} from './orchestrator';
import {AskQuestionSchema} from './schema';

/** FR-23 — the suggested questions the interface offers as one-click chips. */
const EXAMPLE_QUESTIONS = [
	'What is our overall loss ratio?',
	'How many claims did we receive each month in 2025?',
	'Which region has the highest average claim severity?',
	'Show me the top 10 garages by total repair cost',
	'Compare loss ratio by vehicle category',
	'What is the average time between claim notification and settlement?',
	'Compare claim frequency by channel',
	'Which policies have more than two claims?'
];

class QueryHandler {
	/**
	 * FR-08 – FR-17. The conversational pipeline.
	 *
	 * Rate-limited per user (FR-18). The bound is on cost as much as abuse: every
	 * question is a model call the operator pays for and a database query under a
	 * 10-second ceiling.
	 */
	@route({schema: AskQuestionSchema, rateLimiter: queryRateLimiter})
	static async ask(req: CustomRequest, _res: Response) {
		const result = await answerQuestion(req.user, req.body.data.question);

		if (isRefusal(result)) {
			/**
			 * A refusal is thrown as a shaped error so the central handler renders it,
			 * which keeps the response envelope identical to every other error in the
			 * system.
			 *
			 * This throw unwinds the decorator's transaction — which is precisely why the
			 * audit write does NOT use it (defect D-14). The record is already committed
			 * on its own connection and survives.
			 *
			 * `queryId` goes in `meta`, which the error renderer STRIPS before responding
			 * (defect D-19: an earlier comment here claimed the client received it). It is
			 * a server-log aid only. The interface learns about the blocked attempt by
			 * refetching its history, which is the right way round — the list then shows
			 * what the audit log recorded rather than what the client believes it asked.
			 * Blocked questions are SHOWN, not hidden (docs §8.3).
			 */
			throw createError(result.userMessage, result.httpStatus, {queryId: result.queryId});
		}

		/**
		 * FR-05 / TH-07. `generatedSql`, `failedCheck` and `rejectionReason` are DELETED
		 * from the object for an EXECUTIVE — not nulled, not hidden by the client. The
		 * key is absent from the serialised JSON.
		 */
		return {data: projectForRole(result, req.user.role)};
	}

	/** FR-25 — the caller's own history, never anyone else's. */
	@route()
	static async history(req: CustomRequest, _res: Response) {
		const rows = await Audit.history(req.trx, req.user.id);

		const shaped = rows.map((row: Record<string, any>) => ({
			id: row.id as number,
			question: row.question as string,
			validationStatus: row.validation_status as string,
			executionStatus: row.execution_status as string,
			rowCount: row.row_count as number | null,
			durationMs: row.duration_ms as number | null,
			chartType: row.chart_type as string | null,
			createdAt: row.created_at as Date,
			// Stripped for EXECUTIVE below. The BLOCKED rows matter most here: a
			// rejectionReason names the table that was reached for, which is exactly the
			// oracle §4 rule 7 forbids.
			generatedSql: row.generated_sql as string | null,
			failedCheck: row.failed_check as string | null,
			rejectionReason: row.rejection_reason as string | null
		}));

		return {data: projectListForRole(shaped, req.user.role)};
	}

	/** FR-23 — suggested questions. */
	@route()
	static async examples(_req: CustomRequest, _res: Response) {
		return {data: EXAMPLE_QUESTIONS};
	}
}

export default QueryHandler;
