import {Response} from 'express';
import {CATALOGUE, METRIC_GLOSSARY, renderSchemaForLlm} from '../guard/catalogue';
import {CustomRequest} from '../_typings/types';
import {route} from '../routesCreator';
import {MetricsQuery} from './queries';

class MetricsHandler {
	/**
	 * FR-22 — the five (here six) headline figures shown on entry.
	 *
	 * Available to any authenticated user, EXECUTIVE included. These are the numbers the
	 * user manual says can be relied on, and they are the reason an LLM outage degrades
	 * the product rather than stopping it (NFR-12).
	 */
	@route()
	static async headline(req: CustomRequest, _res: Response) {
		return {data: await MetricsQuery.headline(req.trx)};
	}

	/** The dashboard's temporal series. */
	@route()
	static async trend(req: CustomRequest, _res: Response) {
		const points = await MetricsQuery.trend(req.trx);
		return {data: points, count: points.length};
	}

	/**
	 * ANALYST only (FR-05, docs §8.1) — **exactly what the LLM is shown**.
	 *
	 * Not a re-description, not a prettier version for humans: `rendered` is the literal
	 * output of `renderSchemaForLlm()`, the same string the context assembler puts in the
	 * system prompt. If an analyst is going to verify how an answer was produced, the
	 * schema they inspect has to be the schema the model actually saw — a second,
	 * hand-maintained copy would drift and quietly make the audit trail wrong.
	 *
	 * The structured form is included alongside it so the interface can render a table
	 * without parsing the prompt text.
	 */
	@route({requiredRole: 'ANALYST'})
	static async schema(_req: CustomRequest, _res: Response) {
		return {
			data: {
				tables: CATALOGUE,
				glossary: METRIC_GLOSSARY,
				rendered: renderSchemaForLlm()
			}
		};
	}
}

export default MetricsHandler;
