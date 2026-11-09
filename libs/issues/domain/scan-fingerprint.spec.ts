import { computeScanFingerprint, cweFamily } from './scan-fingerprint';

describe('computeScanFingerprint', () => {
    const base = {
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

    it('ignores the class casing', () => {
        expect(
            computeScanFingerprint({ ...base, vulnerabilityClass: 'AUTHZ ' }),
        ).toBe(computeScanFingerprint(base));
    });

    it.each([
        ['repository', { repositoryId: 'repo-2' }],
        ['class', { vulnerabilityClass: 'injection' }],
        ['file', { filePath: 'src/orders/orders.service.ts' }],
        ['symbol', { symbol: 'OrdersController.update' }],
        ['kind of weakness', { cwe: 'CWE-89' }],
    ])('changes when the %s changes', (_name, change) => {
        expect(computeScanFingerprint({ ...base, ...change })).not.toBe(
            computeScanFingerprint(base),
        );
    });

    it('treats a missing symbol as the file-level finding', () => {
        expect(
            computeScanFingerprint({ ...base, symbol: undefined }),
        ).toBe(computeScanFingerprint({ ...base, symbol: '' }));
    });

    it('is one issue whether the missing check is named authentication or authorization', () => {
        expect(computeScanFingerprint({ ...base, cwe: 'CWE-306' })).toBe(
            computeScanFingerprint({ ...base, cwe: 'CWE-862' }),
        );
    });

    it('keys an app-wide setting once per repository, whatever route reports it', () => {
        const csrf = { ...base, vulnerabilityClass: 'misconfiguration', cwe: 'CWE-352' };
        expect(
            computeScanFingerprint({ ...csrf, filePath: 'app/routes/a.py', symbol: 'create' }),
        ).toBe(
            computeScanFingerprint({ ...csrf, filePath: 'app/routes/b.py', symbol: 'update' }),
        );
        // A route-level weakness still keeps its place.
        expect(
            computeScanFingerprint({ ...base, filePath: 'app/routes/a.py' }),
        ).not.toBe(computeScanFingerprint({ ...base, filePath: 'app/routes/b.py' }));
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
        ['CWE-1234', 'cwe-1234'],
        [undefined, ''],
    ])('%s → %s', (cwe, family) => {
        expect(cweFamily(cwe)).toBe(family);
    });
});
