import * as dotenv from 'dotenv';
import type {Config} from 'jest';

dotenv.config({path: '.env.test'});

/**
 * UNIT test configuration — the validation gate's corpus lives here.
 *
 * NOTE, and this is not incidental: the template's equivalent config passes VACUOUSLY.
 * It collects from `__tests__` directories that do not exist, matches nothing, and
 * exits green. PrudenTia's adversarial corpus is a unit suite, so a vacuous pass here
 * would mean the security-critical tests silently never run.
 *
 * `testMatch` therefore points at `src/**\/__tests__/*.test.ts` explicitly, and
 * `npm run verify` fails if the gate suite reports zero tests. If you change this file,
 * confirm the run reports a non-zero test count before believing a green result.
 *
 * NFR-17: gate coverage ≥ 90% of statements, enforced below rather than read off a
 * report by eye.
 */
const config: Config = {
	clearMocks: true,
	preset: 'ts-jest',
	testEnvironment: 'node',
	moduleFileExtensions: ['js', 'ts', 'json', 'd.ts'],
	transform: {
		'^.+\\.ts$': [
			'ts-jest',
			{
				isolatedModules: true,
				diagnostics: false,
				tsconfig: './tsconfig.json'
			}
		]
	},
	testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
	testPathIgnorePatterns: ['/dist/', '/node_modules/', '__e2e__'],

	collectCoverageFrom: ['<rootDir>/src/guard/**/*.ts', '!<rootDir>/src/guard/**/__tests__/**'],
	coveragePathIgnorePatterns: ['node_modules', '_migrations', '_seeds'],
	coverageThreshold: {
		// Jest's type requires `global`. It is deliberately 0: NFR-17 places its
		// requirement on the gate SPECIFICALLY, and a global floor here would either be
		// meaningless (set low) or would dilute the real one (set high, then met by
		// easy-to-cover modules while the gate slips). Overall coverage is reported
		// honestly in Phase 7 rather than enforced as a number nobody chose.
		global: {statements: 0, branches: 0, functions: 0, lines: 0},

		// The requirement that matters. Scoped to the file the security argument rests on.
		'./src/guard/validator.ts': {
			statements: 90,
			branches: 80,
			functions: 90,
			lines: 90
		}
	}
};

export default config;
