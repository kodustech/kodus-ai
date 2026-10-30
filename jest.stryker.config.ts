// Jest config used ONLY by the Stryker mutation runner.
// Two deltas vs the main config:
//   1) forceExit — the suite has open handles (long timers, DB connections)
//      that make plain jest hang and stall Stryker's dry run.
//   2) testMatch — Stryker's dry run runs the WHOLE suite (1.7k specs) unless
//      you scope it, which times out. Scope it to ONLY the specs that exercise
//      the file(s) under --mutate. `mutation:diff` computes those from the
//      changed files and passes them as a JSON array in STRYKER_JEST_TESTMATCH;
//      the default below is the manual resolve-model-slot run.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const base = require('./jest.config.ts').default ?? require('./jest.config.ts');

const testMatch: string[] = process.env.STRYKER_JEST_TESTMATCH
    ? (JSON.parse(process.env.STRYKER_JEST_TESTMATCH) as string[])
    : [
          '<rootDir>/libs/llm/resolve-model-slot.spec.ts',
          '<rootDir>/libs/llm/resolve-task-model.spec.ts',
          '<rootDir>/libs/llm/migrate-byok-config.spec.ts',
          '<rootDir>/libs/llm/byok-migration-build.spec.ts',
      ];

export default {
    ...base,
    forceExit: true,
    detectOpenHandles: false,
    testTimeout: 30000,
    testMatch,
};
