// Jest config used ONLY by the Stryker mutation runner.
// Two deltas vs the main config:
//   1) forceExit — the suite has open handles (long timers, DB connections)
//      that make plain jest hang and stall Stryker's dry run.
//   2) testMatch — Stryker's dry run runs the WHOLE suite (1.7k specs) unless
//      you scope it, which times out. Point it at ONLY the specs that exercise
//      the file(s) under --mutate. Update this list per target (or generate it
//      from the changed files in CI).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const base = require('./jest.config.ts').default ?? require('./jest.config.ts');

export default {
    ...base,
    forceExit: true,
    detectOpenHandles: false,
    testTimeout: 30000,
    // Specs that import libs/llm/resolve-model-slot.ts (the current --mutate target).
    testMatch: [
        '<rootDir>/libs/llm/resolve-model-slot.spec.ts',
        '<rootDir>/libs/llm/resolve-task-model.spec.ts',
        '<rootDir>/libs/llm/migrate-byok-config.spec.ts',
        '<rootDir>/libs/llm/byok-migration-build.spec.ts',
    ],
};
