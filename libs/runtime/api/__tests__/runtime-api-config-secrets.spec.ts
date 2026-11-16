import { loadRuntimeApiConfig } from '../infrastructure/runtime-api.config';

// The dev composes (docker-compose.dev.yml) default both HMAC secrets to
// values that are public in the repo: a production API signing Run tokens
// or evidence URLs with one lets anyone mint them (review 2026-11-14,
// hardening notes).
const DEV_RUN_TOKEN = 'dev-only-runtime-run-token-secret-0000';
const DEV_EVIDENCE = 'dev-only-runtime-evidence-signing-secret-000000';
const OWN = 'q8Jm3vZ0r6L1yT9wB4nK7cX2pF5sH0dGa1E';

describe('runtime API secrets in production', () => {
    for (const prod of [{ NODE_ENV: 'production' }, { RUNTIME_PRODUCTION_IMAGE: '1' }]) {
        it(`refuses the dev-only values, a blank one and one shorter than 32 characters (${Object.keys(prod)[0]})`, () => {
            expect(() => loadRuntimeApiConfig({ ...prod, RUNTIME_RUN_TOKEN_SECRET: DEV_RUN_TOKEN })).toThrow(/RUNTIME_RUN_TOKEN_SECRET is the dev-only value/);
            expect(() => loadRuntimeApiConfig({ ...prod, RUNTIME_EVIDENCE_SIGNING_SECRET: DEV_EVIDENCE })).toThrow(/RUNTIME_EVIDENCE_SIGNING_SECRET is the dev-only value/);
            expect(() => loadRuntimeApiConfig({ ...prod, RUNTIME_RUN_TOKEN_SECRET: '    ' })).toThrow(/RUNTIME_RUN_TOKEN_SECRET must be at least 32 characters/);
            expect(() => loadRuntimeApiConfig({ ...prod, RUNTIME_EVIDENCE_SIGNING_SECRET: 'short-secret' })).toThrow(/RUNTIME_EVIDENCE_SIGNING_SECRET must be at least 32 characters/);
        });
    }

    it('never puts the refused value in the error', () => {
        let message = '';
        try {
            loadRuntimeApiConfig({ NODE_ENV: 'production', RUNTIME_RUN_TOKEN_SECRET: 'short-secret' });
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).not.toBe('');
        expect(message).not.toContain('short-secret');
    });

    it("takes the deployment's own secrets, and leaves an unset one off (Runtime disabled)", () => {
        const c = loadRuntimeApiConfig({ NODE_ENV: 'production', RUNTIME_RUN_TOKEN_SECRET: OWN, RUNTIME_EVIDENCE_SIGNING_SECRET: `${OWN}-e` });
        expect(c.runTokenSecret).toBe(OWN);
        expect(c.evidenceSigningSecret).toBe(`${OWN}-e`);
        const off = loadRuntimeApiConfig({ NODE_ENV: 'production', RUNTIME_RUN_TOKEN_SECRET: '' });
        expect(off.runTokenSecret).toBeUndefined();
        expect(off.evidenceSigningSecret).toBeUndefined();
    });

    it('outside production the dev composes keep working with their defaults', () => {
        const c = loadRuntimeApiConfig({ NODE_ENV: 'development', RUNTIME_RUN_TOKEN_SECRET: DEV_RUN_TOKEN, RUNTIME_EVIDENCE_SIGNING_SECRET: DEV_EVIDENCE });
        expect(c.runTokenSecret).toBe(DEV_RUN_TOKEN);
        expect(c.evidenceSigningSecret).toBe(DEV_EVIDENCE);
    });
});
