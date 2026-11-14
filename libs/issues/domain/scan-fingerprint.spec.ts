import {
    computeScanFingerprint,
    cweFamily,
    repositoryHost,
} from './scan-fingerprint';

describe('computeScanFingerprint', () => {
    const base = {
        repositoryPlatform: 'github',
        repositoryHost: 'github.com',
        repositoryId: 'repo-1',
        vulnerabilityClass: 'authz',
        filePath: 'src/orders/orders.controller.ts',
        symbol: 'OrdersController.findOne',
        cwe: 'CWE-639',
    };

    it('is stable for the same finding', () => {
        expect(computeScanFingerprint(base)).toBe(
            computeScanFingerprint({ ...base }),
        );
    });

    it('ignores path spelling differences', () => {
        expect(
            computeScanFingerprint({
                ...base,
                filePath: './src\\orders\\orders.controller.ts',
            }),
        ).toBe(computeScanFingerprint(base));
    });

    it('is one issue whichever lens reports the bug', () => {
        const secret = {
            ...base,
            filePath: 'config/env/all.js',
            symbol: undefined,
            cwe: 'CWE-798',
        };
        expect(
            computeScanFingerprint({
                ...secret,
                vulnerabilityClass: 'misconfiguration',
            }),
        ).toBe(
            computeScanFingerprint({
                ...secret,
                vulnerabilityClass: 'secret_identity',
            }),
        );
    });

    it('tells findings without a CWE apart by their lens', () => {
        const noCwe = { ...base, cwe: undefined };
        expect(
            computeScanFingerprint({ ...noCwe, vulnerabilityClass: 'authz' }),
        ).not.toBe(
            computeScanFingerprint({ ...noCwe, vulnerabilityClass: 'ssrf' }),
        );
        expect(
            computeScanFingerprint({ ...noCwe, vulnerabilityClass: 'AUTHZ ' }),
        ).toBe(computeScanFingerprint({ ...noCwe, vulnerabilityClass: 'authz' }));
    });

    it.each([
        ['repository', { repositoryId: 'repo-2' }],
        // A GitLab project can carry the id of a GitHub repository.
        ['platform', { repositoryPlatform: 'gitlab' }],
        // Two self-hosted servers of one platform each have a project 1.
        ['instance', { repositoryHost: 'gitlab.acme.io' }],
        ['file', { filePath: 'src/orders/orders.service.ts' }],
        ['symbol', { symbol: 'OrdersController.update' }],
        ['kind of weakness', { cwe: 'CWE-89' }],
    ])('changes when the %s changes', (_name, change) => {
        expect(computeScanFingerprint({ ...base, ...change })).not.toBe(
            computeScanFingerprint(base),
        );
    });

    it('treats a missing symbol as the file-level finding', () => {
        expect(computeScanFingerprint({ ...base, symbol: undefined })).toBe(
            computeScanFingerprint({ ...base, symbol: '' }),
        );
    });

    it('is one issue whether the missing check is named authentication or authorization', () => {
        expect(computeScanFingerprint({ ...base, cwe: 'CWE-306' })).toBe(
            computeScanFingerprint({ ...base, cwe: 'CWE-862' }),
        );
    });

    it('keys an app-wide setting once per repository, whatever route reports it', () => {
        const csrf = {
            ...base,
            vulnerabilityClass: 'misconfiguration',
            cwe: 'CWE-352',
            appWide: true,
        };
        expect(
            computeScanFingerprint({
                ...csrf,
                filePath: 'app/routes/a.py',
                symbol: 'create',
            }),
        ).toBe(
            computeScanFingerprint({
                ...csrf,
                filePath: 'app/routes/b.py',
                symbol: 'update',
            }),
        );
        // A route-level weakness still keeps its place.
        expect(
            computeScanFingerprint({ ...base, filePath: 'app/routes/a.py' }),
        ).not.toBe(
            computeScanFingerprint({ ...base, filePath: 'app/routes/b.py' }),
        );
    });

    it('keeps two routes exempted from CSRF apart: each is fixed on its own', () => {
        const exempt = {
            ...base,
            vulnerabilityClass: 'misconfiguration',
            cwe: 'CWE-352',
            filePath: 'bank/views.py',
        };
        expect(
            computeScanFingerprint({ ...exempt, symbol: 'transfer' }),
        ).not.toBe(
            computeScanFingerprint({ ...exempt, symbol: 'change_email' }),
        );
    });

    it('folds a shared-setting CWE only when the finding says it is shared', () => {
        const csrf = (filePath: string, appWide?: boolean) =>
            computeScanFingerprint({
                ...base,
                vulnerabilityClass: 'misconfiguration',
                cwe: 'CWE-352',
                filePath,
                appWide,
            });
        // The CWE alone used to fold these two routes into one issue.
        expect(csrf('a.py')).not.toBe(csrf('b.py'));
        expect(csrf('a.py', true)).toBe(csrf('b.py', true));
    });

    it('never folds a place-bound CWE, even when called app-wide', () => {
        const fixation = (filePath: string) =>
            computeScanFingerprint({
                ...base,
                cwe: 'CWE-384',
                filePath,
                appWide: true,
            });
        expect(fixation('a.py')).not.toBe(fixation('b.py'));
    });

    it('keeps a broken login and unlimited guessing apart from a missing check', () => {
        const missing = computeScanFingerprint({ ...base, cwe: 'CWE-306' });
        expect(computeScanFingerprint({ ...base, cwe: 'CWE-287' })).not.toBe(
            missing,
        );
        expect(computeScanFingerprint({ ...base, cwe: 'CWE-307' })).not.toBe(
            missing,
        );
    });

    it('keys each app-wide setting on its own CWE, and keeps place-bound ones in their place', () => {
        const cookie = (cwe: string, filePath: string) =>
            computeScanFingerprint({
                ...base,
                vulnerabilityClass: 'misconfiguration',
                cwe,
                filePath,
                appWide: true,
            });
        // Two missing cookie flags are two settings, each once per repository.
        expect(cookie('CWE-614', 'a.py')).toBe(cookie('CWE-614', 'b.py'));
        expect(cookie('CWE-614', 'a.py')).not.toBe(cookie('CWE-1004', 'a.py'));
        // Session fixation (same family) lives where the login is.
        expect(cookie('CWE-384', 'a.py')).not.toBe(cookie('CWE-384', 'b.py'));
    });

    it('keeps the identity when the model names a neighbouring CWE', () => {
        expect(computeScanFingerprint({ ...base, cwe: 'CWE-862' })).toBe(
            computeScanFingerprint(base),
        );
    });
});

describe('cweFamily', () => {
    it.each([
        ['CWE-89', 'sql'],
        ['CWE-943', 'sql'],
        ['cwe-79', 'xss'],
        ['CWE 1336', 'template'],
        ['CWE-400', 'exhaustion'],
        ['CWE-1333', 'exhaustion'],
        ['CWE-1234', 'cwe-1234'],
        ['OWASP A03:2021 CWE-89', 'sql'],
        ['89', 'sql'],
        ['OWASP A01:2021', ''],
        [undefined, ''],
    ])('%s → %s', (cwe, family) => {
        expect(cweFamily(cwe)).toBe(family);
    });
});

describe('repositoryHost', () => {
    it.each([
        ['https://GitLab.Acme.io/group/shop.git', 'gitlab.acme.io'],
        ['https://git.acme.dev:8443/acme/shop', 'git.acme.dev:8443'],
        ['https://github.com/acme/shop', 'github.com'],
        ['not a url', ''],
        [undefined, ''],
    ])('reads the instance of %s', (url, host) => {
        expect(repositoryHost(url)).toBe(host);
    });
});
