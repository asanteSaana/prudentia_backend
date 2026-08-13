/**
 * ESLint rule enforcing CLAUDE.md §2 — the rule that overrides everything else:
 *
 *   "No SQL string ever reaches the database without passing the validation gate."
 *
 * Modelled on the template's `no-direct-db-instance`, which is the best idea in the
 * template estate: it turns a written instruction into a mechanical one. A convention
 * a reviewer has to remember is a convention that eventually gets forgotten.
 *
 * Two checks, both fail-closed:
 *
 *  1. `ReadOnlyDatabase` — the SELECT-only connection exists for exactly one purpose,
 *     executing validated generated SQL. Reaching for it anywhere but the guarded
 *     executor means someone is about to run something the gate has not seen.
 *
 *  2. `.raw(<non-literal>)` — a raw call whose SQL is a variable, template literal with
 *     substitutions, or concatenation. Inside the guarded executor that is the whole
 *     point; anywhere else it is either SQL injection or an end-run around the gate.
 *     A raw call with a plain string literal is fine everywhere: the hand-written
 *     headline metrics (FR-22) are exactly that, and they carry no user input by
 *     construction.
 *
 * ALLOWED:
 *   src/guard/executor.ts   — the one place validated SQL is executed
 *   src/guard/validator.ts  — re-parses the wrapped statement (CLAUDE.md §4 rule 3)
 *   src/_migrations/**      — schema and role provisioning, no user input
 *   src/_seeds/**           — deterministic generator, no user input
 *   src/_e2e/**, scripts/** — harness and tooling
 *
 * BLOCKED: everywhere else.
 */

const ALLOWED_PATTERNS = [
	'/src/guard/executor.ts',
	'/src/guard/validator.ts',
	/**
	 * The boot-time privilege prober. It must hold the read-only connection and must
	 * issue a write through it — proving the write is refused is the entire purpose
	 * (NFR-02). Sanctioned by name rather than by loosening the rule, so the exemption
	 * is as reviewable as the rule.
	 *
	 * Its dynamic `.raw()` interpolates table names from APPLICATION_TABLE_LIST, a
	 * hard-coded constant. No request data reaches it.
	 */
	'/src/_services/readOnlyValidator.ts',
	'/src/_migrations/',
	'/src/_seeds/',
	'/src/_e2e/',
	'/scripts/',
	'/dist/',
	'/node_modules/'
];

/** A template literal with no `${}` substitutions is just a string literal. */
function isStaticSql(node) {
	if (!node) return true; // `.raw()` with no argument is not our problem
	if (node.type === 'Literal') return typeof node.value === 'string';
	if (node.type === 'TemplateLiteral') return node.expressions.length === 0;
	return false;
}

module.exports = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Disallow reaching the database with un-validated SQL outside the guard',
			category: 'Security',
			recommended: true
		},
		messages: {
			noReadOnlyOutsideGuard: [
				'SECURITY: ReadOnlyDatabase reached outside src/guard/.',
				'',
				'The SELECT-only connection exists to execute SQL the validation gate has',
				'already proven safe. Using it elsewhere means executing something unproven.',
				'',
				'  BAD:   const rows = await ReadOnlyDatabase.getInstance().raw(sql);',
				'  GOOD:  const result = await GuardedExecutor.execute(validated.normalisedSql);',
				'',
				'CLAUDE.md §2, §4 rule 4.'
			].join('\n'),
			noDynamicRaw: [
				'SECURITY: knex.raw() called with SQL built at runtime.',
				'',
				'Only the guarded executor may run SQL that is not a fixed string literal.',
				'If this is a hand-written analytical query, make it a literal and bind',
				'parameters:',
				'',
				'  BAD:   knex.raw(`SELECT * FROM claims WHERE id = ${id}`)',
				'  GOOD:  knex.raw("SELECT * FROM claims WHERE id = ?", [id])',
				'',
				'If this is generated SQL, it must go through src/guard/validator.ts first.',
				'CLAUDE.md §2, §7.'
			].join('\n')
		},
		schema: []
	},

	create(context) {
		const filename = context.getFilename();
		// Normalise Windows backslashes so the forward-slash allow patterns match on
		// every platform — otherwise the exemptions silently miss on Windows.
		const relativePath = filename.replace(process.cwd(), '').replace(/\\/g, '/');

		if (ALLOWED_PATTERNS.some(pattern => relativePath.includes(pattern))) {
			return {};
		}

		return {
			CallExpression(node) {
				const callee = node.callee;

				// 1. ReadOnlyDatabase.<anything>() outside the guard.
				if (
					callee.type === 'MemberExpression' &&
					callee.object &&
					callee.object.name === 'ReadOnlyDatabase'
				) {
					context.report({node, messageId: 'noReadOnlyOutsideGuard'});
					return;
				}

				// 2. <anything>.raw(<non-literal>)
				if (
					callee.type === 'MemberExpression' &&
					callee.property &&
					callee.property.name === 'raw' &&
					!isStaticSql(node.arguments[0])
				) {
					context.report({node, messageId: 'noDynamicRaw'});
				}
			},

			// Importing the read-only connection at all is a smell worth flagging at the
			// import site, which is where CLAUDE.md §4 rule 4 says the mistake should be
			// visible.
			ImportSpecifier(node) {
				if (node.imported && node.imported.name === 'ReadOnlyDatabase') {
					context.report({node, messageId: 'noReadOnlyOutsideGuard'});
				}
			}
		};
	}
};
