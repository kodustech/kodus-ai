/**
 * Regression tests for issue #1099 — the JWT config loader used to
 * pass `process.env.API_JWT_EXPIRES_IN` straight through. When the
 * env was unset (typical on a fresh self-hosted install), the value
 * resolved to `undefined`, jsonwebtoken's `jwt.sign(...)` threw
 * `"expiresIn" should be a number of seconds or string representing
 * a timespan`, and login was impossible until the operator figured
 * out the env was required. The loader now applies safe defaults.
 */

import { jwtConfigLoader } from './jwt.config.loader';

describe('jwtConfigLoader — defaults (issue #1099)', () => {
    const envBackup = { ...process.env };

    afterEach(() => {
        process.env = { ...envBackup };
    });

    function loadFreshLoader(): { default: any } {
        // The loader is a `registerAs(...)` factory — calling its
        // returned function (`.KEY` is set by `registerAs`) yields
        // the current snapshot of env values, so we don't need
        // module cache busting.
        return { default: (jwtConfigLoader as unknown as () => any)() };
    }

    it('falls back to 1d / 7d when both envs are unset (the #1099 symptom)', () => {
        delete process.env.API_JWT_EXPIRES_IN;
        delete process.env.API_JWT_REFRESH_EXPIRES_IN;

        const cfg = loadFreshLoader().default;
        expect(cfg.expiresIn).toBe('1d');
        expect(cfg.refreshExpiresIn).toBe('7d');
    });

    it('respects API_JWT_EXPIRES_IN when set', () => {
        process.env.API_JWT_EXPIRES_IN = '15m';
        delete process.env.API_JWT_REFRESH_EXPIRES_IN;

        const cfg = loadFreshLoader().default;
        expect(cfg.expiresIn).toBe('15m');
        expect(cfg.refreshExpiresIn).toBe('7d');
    });

    it('respects API_JWT_REFRESH_EXPIRES_IN when set', () => {
        delete process.env.API_JWT_EXPIRES_IN;
        process.env.API_JWT_REFRESH_EXPIRES_IN = '30d';

        const cfg = loadFreshLoader().default;
        expect(cfg.expiresIn).toBe('1d');
        expect(cfg.refreshExpiresIn).toBe('30d');
    });

    it('keeps secret + refreshSecret + private key as raw env reads (no defaults)', () => {
        // Secrets must NEVER have a default — leaking with a hardcoded
        // secret would be worse than failing to boot. Verify the loader
        // still returns undefined for those when env is absent.
        delete process.env.API_JWT_SECRET;
        delete process.env.API_JWT_REFRESH_SECRET;
        delete process.env.API_JWT_PRIVATE_KEY;

        const cfg = loadFreshLoader().default;
        expect(cfg.secret).toBeUndefined();
        expect(cfg.refreshSecret).toBeUndefined();
        expect(cfg.helpdeskPrivateKey).toBeUndefined();
    });
});
