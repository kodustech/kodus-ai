import {
    coverageEntryOf,
    parseStagedListing,
    unchangedFiles,
} from './coverage-ledger';

const blobs = new Map([
    ['src/a.ts', 'a1'],
    ['src/auth.ts', 'g1'],
    ['src/b.ts', 'b1'],
]);

describe('unchangedFiles', () => {
    it('holds a file whose blob and every evidence blob are unchanged', () => {
        const got = unchangedFiles(
            [
                {
                    filePath: 'src/a.ts',
                    vulnerabilityClass: 'authz',
                    blob: 'a1',
                    evidence: [{ file: 'src/auth.ts', blob: 'g1' }],
                },
            ],
            blobs,
        );
        expect([...got]).toEqual(['src/a.ts']);
    });

    it('sends a file back when a file its conclusion leaned on changed', () => {
        const got = unchangedFiles(
            [
                {
                    filePath: 'src/a.ts',
                    vulnerabilityClass: 'authz',
                    blob: 'a1',
                    evidence: [{ file: 'src/auth.ts', blob: 'OLD' }],
                },
            ],
            blobs,
        );
        expect(got.size).toBe(0);
    });

    it('sends a file back when any of its classes no longer holds', () => {
        const got = unchangedFiles(
            [
                { filePath: 'src/b.ts', vulnerabilityClass: 'authz', blob: 'b1', evidence: [] },
                { filePath: 'src/b.ts', vulnerabilityClass: 'injection', blob: 'b0', evidence: [] },
            ],
            blobs,
        );
        expect(got.size).toBe(0);
    });

    it('sends a file back when an evidence file is gone', () => {
        const got = unchangedFiles(
            [
                {
                    filePath: 'src/b.ts',
                    vulnerabilityClass: 'authz',
                    blob: 'b1',
                    evidence: [{ file: 'src/deleted.ts', blob: 'd1' }],
                },
            ],
            blobs,
        );
        expect(got.size).toBe(0);
    });
});

describe('coverageEntryOf', () => {
    it('ties the conclusion to the file and the evidence it read, once each', () => {
        expect(
            coverageEntryOf({
                file: './src/a.ts',
                vulnerabilityClass: 'authz',
                evidence: ['src/auth.ts', 'src/a.ts', 'src/auth.ts', 'node_modules/x.js'],
                blobs,
            }),
        ).toEqual({
            filePath: 'src/a.ts',
            vulnerabilityClass: 'authz',
            blob: 'a1',
            evidence: [{ file: 'src/auth.ts', blob: 'g1' }],
        });
    });

    it('records nothing for a file whose blob is unknown', () => {
        expect(
            coverageEntryOf({ file: 'src/x.ts', vulnerabilityClass: 'authz', evidence: [], blobs }),
        ).toBeNull();
    });
});

describe('parseStagedListing', () => {
    it('reads git ls-files -s -z', () => {
        const out = parseStagedListing(
            '100644 aaa111 0\tsrc/a.ts\u0000100755 bbb222 0\tsrc/ação.sh\u0000',
        );
        expect([...out]).toEqual([
            ['src/a.ts', 'aaa111'],
            ['src/ação.sh', 'bbb222'],
        ]);
    });
});
