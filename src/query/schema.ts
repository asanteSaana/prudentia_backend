import {z} from 'zod';
import {Constants} from '../_services/_constants';

/**
 * FR-08 — a natural language question of up to 500 characters.
 *
 * `.trim()` runs BEFORE `.max()`, and because the route decorator forwards zod's parsed
 * value the trimmed string is what the handler and the audit log actually see. Under the
 * template's Joi path the raw body was forwarded instead, so the length enforced would
 * not have been the length declared — that gap is why zod replaced it (DV-7).
 */
export const AskQuestionSchema = z
	.object({
		question: z
			.string()
			.trim()
			.min(1, 'A question is required.')
			.max(Constants.MAX_QUESTION_LENGTH, `A question must be ${Constants.MAX_QUESTION_LENGTH} characters or fewer.`)
	})
	.strict();

export type AskQuestionInput = z.infer<typeof AskQuestionSchema>;
