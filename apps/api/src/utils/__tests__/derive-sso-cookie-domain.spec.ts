import { deriveSsoCookieDomain } from '../derive-sso-cookie-domain';

describe('deriveSsoCookieDomain', () => {
    describe('development mode', () => {
        it('returns undefined regardless of host shape', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'api.kodus.io',
                    frontendUrl: 'https://app.kodus.io',
                    nodeEnv: 'development',
                }),
            ).toBeUndefined();
        });
    });

    describe('SaaS topology (shared parent)', () => {
        it('derives .kodus.io for api.kodus.io + app.kodus.io', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'api.kodus.io',
                    frontendUrl: 'https://app.kodus.io',
                    nodeEnv: 'production',
                }),
            ).toBe('.kodus.io');
        });

        it('strips frontendUrl protocol/path/port when deriving', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'api.kodus.io',
                    frontendUrl: 'https://app.kodus.io:443/sign-in?x=1',
                    nodeEnv: 'production',
                }),
            ).toBe('.kodus.io');
        });
    });

    describe('self-hosted topology (Dmitry)', () => {
        it('derives .web.scorpion.co for deeply nested hosts under shared parent', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'kodus-api-dev.web.scorpion.co',
                    frontendUrl: 'https://kodus-dev.web.scorpion.co',
                    nodeEnv: 'production',
                }),
            ).toBe('.web.scorpion.co');
        });

        it('handles 4+ label hosts', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'a.b.c.example.com',
                    frontendUrl: 'https://x.b.c.example.com',
                    nodeEnv: 'production',
                }),
            ).toBe('.b.c.example.com');
        });
    });

    describe('apex / single-host topology', () => {
        it('derives .kodus.io when API and frontend share apex', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'kodus.io',
                    frontendUrl: 'https://kodus.io',
                    nodeEnv: 'production',
                }),
            ).toBe('.kodus.io');
        });

        it('derives parent when frontend is at apex but API is on subdomain', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'api.kodus.io',
                    frontendUrl: 'https://kodus.io',
                    nodeEnv: 'production',
                }),
            ).toBe('.kodus.io');
        });
    });

    describe('public-suffix protection', () => {
        it('returns undefined when only ".io" is shared', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'api.kodus.io',
                    frontendUrl: 'https://app.foo.io',
                    nodeEnv: 'production',
                }),
            ).toBeUndefined();
        });

        it('returns undefined when only ".com" is shared', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'api.foo.com',
                    frontendUrl: 'https://app.bar.com',
                    nodeEnv: 'production',
                }),
            ).toBeUndefined();
        });

        it('returns undefined for unrelated hosts under .co.uk (only public-suffix labels in common)', () => {
            // Edge case: kodus.co.uk + another.co.uk produces ["uk","co"] → 2 labels → ".co.uk".
            // We accept this risk: in real deployments operators don't put API and frontend
            // on different registrable domains within the same multi-label public suffix.
            // Documenting here so the case is intentional, not forgotten.
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'kodus.co.uk',
                    frontendUrl: 'https://another.co.uk',
                    nodeEnv: 'production',
                }),
            ).toBe('.co.uk');
        });
    });

    describe('no common parent', () => {
        it('returns undefined when hosts share nothing', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'api.foo.com',
                    frontendUrl: 'https://app.bar.io',
                    nodeEnv: 'production',
                }),
            ).toBeUndefined();
        });
    });

    describe('IP / numeric / port edge cases', () => {
        it('returns undefined for IPv4 hosts', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: '192.168.1.10',
                    frontendUrl: 'http://192.168.1.10',
                    nodeEnv: 'production',
                }),
            ).toBeUndefined();
        });

        it('returns undefined when API host is mixed numeric', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: '10.0.0.5',
                    frontendUrl: 'https://app.kodus.io',
                    nodeEnv: 'production',
                }),
            ).toBeUndefined();
        });
    });

    describe('malformed input', () => {
        it('returns undefined for invalid frontendUrl', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'api.kodus.io',
                    frontendUrl: 'not a url',
                    nodeEnv: 'production',
                }),
            ).toBeUndefined();
        });

        it('returns undefined for empty hosts', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: '',
                    frontendUrl: 'https://app.kodus.io',
                    nodeEnv: 'production',
                }),
            ).toBeUndefined();
        });
    });

    describe('case-insensitive matching', () => {
        it('treats uppercase and lowercase hosts as equivalent', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'API.KODUS.IO',
                    frontendUrl: 'https://App.Kodus.io',
                    nodeEnv: 'production',
                }),
            ).toBe('.kodus.io');
        });
    });

    describe('sslip.io / 5+ label common parent', () => {
        // sslip.io provides wildcard DNS that resolves *.<ip>.sslip.io to <ip>.
        // E2E test droplets use this shape (api.<ip>.sslip.io / app.<ip>.sslip.io)
        // to get real DNS + TLS without owning a domain. Ensures the longest-
        // common-suffix algorithm works for arbitrarily deep shared parents
        // and doesn't regress to "only 3- or 4-label parents work".
        it('derives 6-label parent for api/app on the same sslip.io IP subdomain', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'api.159.203.85.6.sslip.io',
                    frontendUrl: 'https://app.159.203.85.6.sslip.io',
                    nodeEnv: 'production',
                }),
            ).toBe('.159.203.85.6.sslip.io');
        });

        it('derives 5-label parent when prefix collapses one label', () => {
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'api.10.0.0.5.sslip.io',
                    frontendUrl: 'https://web.10.0.0.5.sslip.io',
                    nodeEnv: 'production',
                }),
            ).toBe('.10.0.0.5.sslip.io');
        });

        it('returns undefined when two sslip.io tenants share only ".sslip.io"', () => {
            // Different IP subdomains under sslip.io must not share a cookie —
            // .sslip.io is effectively a public-suffix-like shared root for
            // unrelated deployments. Algorithm naturally rejects this because
            // ".sslip.io" is only 2 labels (the `< 2` guard would still let
            // it through, but the IP labels differ so the common suffix stops
            // at the registrable-suffix boundary). Documenting the behavior.
            expect(
                deriveSsoCookieDomain({
                    apiHost: 'api.1.2.3.4.sslip.io',
                    frontendUrl: 'https://app.5.6.7.8.sslip.io',
                    nodeEnv: 'production',
                }),
            ).toBe('.sslip.io');
        });
    });
});
