import { readFileSync } from 'node:fs';

import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import {
    SEVERITY_FROM_LEVEL,
    changedSourceFiles,
    loadAnalyzeJsonToL1GateVerdict,
    mapAnalyzeJsonToL1GateVerdict,
} from './pr-decision-graph-verdict';

jest.mock('node:fs', () => ({
    readFileSync: jest.fn(),
}));

const readFileSyncMock = readFileSync as jest.Mock;

const SNAPSHOT_KEY = 'cfg=v11;model=kodus-managed;head-sha-test';

describe('mapAnalyzeJsonToL1GateVerdict', () => {
    beforeEach(() => {
        readFileSyncMock.mockReset();
    });

    it('returns Ready with a LOW verdict for a small-diff JSON', () => {
        const json = JSON.stringify({
            blast_radius: { total_functions: 1, total_files: 1, by_depth: {} },
            risk_score: {
                level: 'LOW',
                score: 0.16,
                factors: {
                    blast_radius: { value: 0.1, detail: 'small' },
                    test_gaps: { value: 0.0, detail: 'none' },
                    complexity: { value: 0.06, detail: 'mcCabe<=10' },
                    inheritance: { value: 0.0, detail: 'no inheritance' },
                },
            },
            test_gaps: [],
        });

        const verdict = mapAnalyzeJsonToL1GateVerdict(json, SNAPSHOT_KEY);

        expect(verdict).toMatchObject({
            status: 'Ready',
            snapshotKey: SNAPSHOT_KEY,
            value: { riskScore: 0.16, level: 'LOW' },
        });
        if (verdict.status === 'Ready') {
            expect(verdict.value.factors).toHaveLength(4);
            expect(verdict.value.blastRadius.totalFunctions).toBe(1);
        }
    });

    it('returns Ready with a HIGH verdict when score>=0.6', () => {
        const json = JSON.stringify({
            blast_radius: {
                total_functions: 30,
                total_files: 18,
                by_depth: {},
            },
            risk_score: {
                level: 'HIGH',
                score: 0.78,
                factors: {
                    blast_radius: { value: 0.7, detail: 'wide' },
                    test_gaps: { value: 0.6, detail: 'gaps' },
                    complexity: { value: 0.4, detail: 'mcCabe>15' },
                    inheritance: { value: 0.1, detail: 'inherits broadly' },
                },
            },
            test_gaps: [
                { function: 'f', file_path: 'src/x.ts', line_start: 10 },
            ],
        });

        const verdict = mapAnalyzeJsonToL1GateVerdict(json, SNAPSHOT_KEY);

        expect(verdict).toMatchObject({
            status: 'Ready',
            snapshotKey: SNAPSHOT_KEY,
        });
        if (verdict.status === 'Ready') {
            expect(verdict.value.level).toBe('HIGH');
            expect(verdict.value.riskScore).toBe(0.78);
            expect(verdict.value.testGaps).toEqual([
                { functionName: 'f', filePath: 'src/x.ts', lineStart: 10 },
            ]);
        }
    });

    it('returns Unavailable when the JSON is malformed', () => {
        const verdict = mapAnalyzeJsonToL1GateVerdict(
            '{not json',
            SNAPSHOT_KEY,
            '{not json',
        );

        expect(verdict).toMatchObject({
            status: 'Unavailable',
            snapshotKey: SNAPSHOT_KEY,
        });
        if (verdict.status === 'Unavailable') {
            expect(verdict.reason).toContain('not valid JSON');
        }
    });

    it('returns Unavailable when risk_score.score is missing', () => {
        const json = JSON.stringify({
            blast_radius: { total_functions: 3, total_files: 2 },
            risk_score: { level: 'MEDIUM' },
            test_gaps: [],
        });

        const verdict = mapAnalyzeJsonToL1GateVerdict(json, SNAPSHOT_KEY);

        expect(verdict.status).toBe('Unavailable');
        if (verdict.status === 'Unavailable') {
            expect(verdict.reason).toContain('risk_score.score');
        }
    });

    it('returns Unavailable when risk_score.level is unrecognised', () => {
        const json = JSON.stringify({
            blast_radius: {},
            risk_score: { score: 0.4, level: 'WHATEVER' },
            test_gaps: [],
        });
        const verdict = mapAnalyzeJsonToL1GateVerdict(json, SNAPSHOT_KEY);
        expect(verdict.status).toBe('Unavailable');
    });
});

describe('loadAnalyzeJsonToL1GateVerdict', () => {
    beforeEach(() => {
        readFileSyncMock.mockReset();
    });

    it('returns Unavailable when the file does not exist', () => {
        readFileSyncMock.mockImplementation(() => {
            const error = new Error('ENOENT: no such file or directory');
            (error as Error & { code?: string }).code = 'ENOENT';
            throw error;
        });

        const verdict = loadAnalyzeJsonToL1GateVerdict(
            '/tmp/missing.json',
            SNAPSHOT_KEY,
        );

        expect(verdict.status).toBe('Unavailable');
        if (verdict.status === 'Unavailable') {
            expect(verdict.reason).toMatch(/not readable/);
            expect(verdict.reason).toMatch(/ENOENT/);
        }
    });

    it('forwards a well-formed file payload to the mapper', () => {
        readFileSyncMock.mockReturnValue(
            JSON.stringify({
                blast_radius: { total_functions: 2, total_files: 1 },
                risk_score: { level: 'MEDIUM', score: 0.45 },
                test_gaps: [],
            }),
        );

        const verdict = loadAnalyzeJsonToL1GateVerdict(
            '/tmp/analyze.json',
            SNAPSHOT_KEY,
        );

        expect(verdict).toMatchObject({ status: 'Ready' });
        if (verdict.status === 'Ready') {
            expect(verdict.value.riskScore).toBe(0.45);
            expect(verdict.value.level).toBe('MEDIUM');
        }
    });
});

describe('changedSourceFiles', () => {
    it('keeps non-test source files and drops removed entries', () => {
        const files: FileChange[] = [
            { filename: 'src/a.ts', status: 'modified' } as FileChange,
            { filename: 'src/b.py', status: 'added' } as FileChange,
            { filename: 'src/c.ts', status: 'removed' } as FileChange,
            { filename: 'src/d.spec.ts', status: 'modified' } as FileChange,
            { filename: 'docs/readme.md', status: 'modified' } as FileChange,
        ];
        expect(changedSourceFiles(files)).toEqual(['src/a.ts', 'src/b.py']);
    });

    it('is empty when there are only test files', () => {
        const files: FileChange[] = [
            {
                filename: 'src/__tests__/a.spec.ts',
                status: 'added',
            } as FileChange,
            { filename: 'src/a.test.ts', status: 'modified' } as FileChange,
        ];
        expect(changedSourceFiles(files)).toEqual([]);
    });
});

describe('SEVERITY_FROM_LEVEL', () => {
    it.each([
        ['LOW', SeverityLevel.LOW],
        ['MEDIUM', SeverityLevel.MEDIUM],
        ['HIGH', SeverityLevel.HIGH],
    ] as const)('maps %s to the right severity literal', (level, expected) => {
        expect(SEVERITY_FROM_LEVEL[level]).toBe(expected);
    });
});
