import type {Config} from 'jest';
import jestConfig from './jest.config';

/**
 * INTEGRATION test configuration — supertest against a live database.
 *
 * Runs only `__e2e__/*.test.ts`, which is the complement of the unit config above.
 * The two together are `npm test`; neither alone is.
 */
const config: Config = {
	...jestConfig,
	testMatch: ['<rootDir>/src/**/__e2e__/**/*.test.ts'],
	testPathIgnorePatterns: ['/dist/', '/node_modules/', '__tests__'],
	setupFilesAfterEnv: ['<rootDir>/jest-e2e.setup.ts'],
	testEnvironment: 'node',
	testRunner: 'jest-circus/runner',
	// Coverage thresholds belong to the unit run; an integration run that happens to
	// miss a branch must not fail the build for a reason it does not measure.
	coverageThreshold: undefined,
	collectCoverageFrom: ['<rootDir>/src/**/*.ts']
};

export default config;
