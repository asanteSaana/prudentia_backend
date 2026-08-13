import {Knex} from 'knex';
import {ApplicationTables} from '../_services/_dbTables';
import {Database} from '../_services/databaseService';
import {ChartType, ExecutionStatus, ValidationStatus} from '../_typings/types';

/**
 * Audit every attempt (ADR-07, FR-17, NFR-15).
 *
 * EVERY attempt — permitted, rejected, failed, timed out. Logging only successes would
 * discard exactly the evidence an incident investigation needs: the rejected ones are
 * the security-relevant records, and a rising rejection rate is the system's primary
 * health signal (a spike means either an attack or a generation regression, and
 * `failed_check` distinguishes them).
 *
 * This is the ONLY place the gate's `reason` and `failedCheck` are persisted, and the
 * only place they are allowed to exist outside the gate. The user receives one fixed
 * sentence; the investigator receives the full record. That asymmetry is the whole
 * design (CLAUDE.md §4 rule 7).
 */

export interface AuditRecord {
	userId: number | null;
	question: string;
	generatedSql: string | null;
	validationStatus: ValidationStatus;
	rejectionReason: string | null;
	failedCheck: string | null;
	executionStatus: ExecutionStatus;
	rowCount: number | null;
	durationMs: number | null;
	chartType: ChartType | null;
}

export namespace Audit {
	/**
	 * Writes the record and returns its id.
	 *
	 * ── This deliberately does NOT use the request transaction (defect D-14) ────
	 *
	 * An audit record documents what happened. It must therefore survive whatever
	 * happens to the request that produced it — including a rollback.
	 *
	 * Writing through `req.trx` looked correct and was not: the refusal path audits and
	 * then throws a shaped error so the central handler renders it, the throw unwinds the
	 * decorator's transaction, and the audit row goes with it. The net effect was that
	 * `query_log` recorded successes and nothing else — silently discarding exactly the
	 * rejected attempts ADR-07 calls the security-relevant record, and the ones a rising
	 * rejection rate is supposed to be visible in.
	 *
	 * CLAUDE.md §7 lists "skipping the audit write on the error path" as tempting and
	 * wrong. Rolling it back is the same mistake wearing a transaction, and it is worse
	 * for being invisible: the code plainly contains the write.
	 *
	 * So the audit connection is independent by construction, and there is no parameter
	 * through which a caller could accidentally re-couple them.
	 */
	export async function record(entry: AuditRecord): Promise<number> {
		const [row] = await Database.getInstance()(ApplicationTables.QueryLog)
			.insert({
				user_id: entry.userId,
				question: entry.question,
				generated_sql: entry.generatedSql,
				validation_status: entry.validationStatus,
				rejection_reason: entry.rejectionReason,
				failed_check: entry.failedCheck,
				execution_status: entry.executionStatus,
				row_count: entry.rowCount,
				duration_ms: entry.durationMs,
				chart_type: entry.chartType
			})
			.returning<Array<{id: number}>>('id');

		return row.id;
	}

	/** The caller's own history (FR-25). Never another user's. */
	export function history(knex: Knex, userId: number, limit = 25) {
		return knex(ApplicationTables.QueryLog)
			.select(
				'id',
				'question',
				'generated_sql',
				'validation_status',
				'rejection_reason',
				'failed_check',
				'execution_status',
				'row_count',
				'duration_ms',
				'chart_type',
				'created_at'
			)
			.where({user_id: userId})
			.orderBy('created_at', 'desc')
			.limit(limit);
	}
}
