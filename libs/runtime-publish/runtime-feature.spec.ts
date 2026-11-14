import { isKodyRuntimeEnabled } from './runtime-feature';

// ProcessEnv declares NODE_ENV as required; these are partial envs.
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe('isKodyRuntimeEnabled', () => {
    it('follows RUNTIME_ENABLED, and without it the run token secret', () => {
        expect(isKodyRuntimeEnabled(env({ RUNTIME_ENABLED: 'true' }))).toBe(true);
        expect(isKodyRuntimeEnabled(env({ RUNTIME_ENABLED: 'false', RUNTIME_RUN_TOKEN_SECRET: 's' }))).toBe(false);
        expect(isKodyRuntimeEnabled(env({ RUNTIME_RUN_TOKEN_SECRET: 's' }))).toBe(true);
        expect(isKodyRuntimeEnabled(env({}))).toBe(false);
    });
});
