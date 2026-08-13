/*
 * The strict-typing gate.
 *
 * The WHOLE backend is strict — src, scripts and knexfile — not merely the validation
 * gate. This departs from the template estate, which runs `strict: false` with
 * noImplicitAny and strictNullChecks off (DV-14).
 *
 * The cost was measured before it was adopted rather than assumed: flipping the base
 * config produced **two** errors across the entire backend. A loose compiler is a
 * reasonable position for a large codebase mid-migration; there is no migration here to
 * pay for, so there was nothing to trade away.
 *
 * This is a ratchet. It only ever tightens.
 *
 * CLAUDE.md §5. Part of `npm run verify`.
 */
const {execSync} = require('child_process');

try {
	// Invoke the compiler's JS entry through node so this runs on Windows (cmd.exe cannot
	// execute the extensionless `.bin/tsc` shim) as well as on Linux CI.
	execSync('node node_modules/typescript/bin/tsc -p tsconfig.strict.json', {encoding: 'utf8', stdio: 'pipe'});
	console.log('Strict typecheck passed: the whole backend is clean under strict TypeScript.');
	process.exit(0);
} catch (error) {
	const output = `${error.stdout || ''}${error.stderr || ''}`;
	console.error('Strict typecheck FAILED:\n');
	console.error(output.trim());
	process.exit(1);
}
