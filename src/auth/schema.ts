import {z} from 'zod';

/**
 * Request schemas for the auth domain (NFR-07 — validated at the boundary, before any
 * business logic sees the value).
 *
 * `.strict()` rejects unknown keys. The email is trimmed and lower-cased HERE rather
 * than in the service, and because the route decorator forwards zod's **parsed** value
 * (not the raw body), that normalisation actually reaches the handler — which is the
 * whole reason zod replaced Joi (DV-7).
 */
export const LoginSchema = z
	.object({
		email: z.string().trim().toLowerCase().email().max(255),
		// No max length and no complexity rules on the way IN. Complexity belongs to
		// registration, not to authentication, and a length cap here would leak which
		// passwords are possible. The value is hashed, never stored or echoed.
		password: z.string().min(1)
	})
	.strict();

export type LoginInput = z.infer<typeof LoginSchema>;
