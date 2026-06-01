import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/__tests__/**/*.test.ts'],
        // A few tests use `vi.doMock('os', …)` to point `homedir()` at a
        // tempdir. With Vitest's default file-level parallelism that mock
        // can leak across workers and flake unrelated FS-touching tests
        // (config/device/credentials utils). Running test files serially
        // costs ~7s on the full suite and removes the flake — worth it.
        fileParallelism: false,
    },
});
