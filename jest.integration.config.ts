// The integration project: every *.integration.spec.ts, in band, after one
// globalSetup. The Kody Runtime's suites are left out of the default run
// (jest.config.ts RUNTIME_INTEGRATION_SPECS) and run only here; each one still
// skips unless its backend is named explicitly:
//   RUNTIME_IT_DATABASE_URL  a disposable Postgres server; every suite takes a
//                            database of its own on it (isolated-database.ts)
//   RUNTIME_IT_GO_CELL=1     the suites that run the real Go cell (go, openssl);
//                            the globalSetup builds the cell once for them
// pnpm run test:runtime-integration runs the Runtime's suites this way.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const config = require('./jest.config.ts');
const base = config.default ?? config;

export default {
    ...base,
    displayName: 'integration',
    testMatch: ['**/*.integration.spec.ts'],
    testPathIgnorePatterns: base.testPathIgnorePatterns.filter((p: string) => p !== config.RUNTIME_INTEGRATION_SPECS),
    // Suites build binaries and hold databases and ports: one at a time.
    maxWorkers: 1,
    // A hook that creates a database and applies every Runtime migration takes
    // seconds on a busy server; the unit default (5 s) failed it, not the code.
    testTimeout: 30_000,
    globalSetup: '<rootDir>/test/jest.integration.global-setup.ts',
    globalTeardown: '<rootDir>/test/jest.integration.global-teardown.ts',
};
