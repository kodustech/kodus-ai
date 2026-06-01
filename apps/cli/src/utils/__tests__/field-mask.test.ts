import { describe, expect, it } from 'vitest';
import { applyFieldMask } from '../field-mask.js';

describe('field mask', () => {
    it('projects top-level fields', () => {
        const result = applyFieldMask(
            {
                summary: 'ok',
                filesAnalyzed: 2,
                duration: 100,
            },
            ['summary', 'filesAnalyzed'],
        );

        expect(result).toEqual({
            summary: 'ok',
            filesAnalyzed: 2,
        });
    });

    it('projects nested fields inside arrays', () => {
        const result = applyFieldMask(
            {
                summary: 'ok',
                issues: [
                    { file: 'a.ts', line: 10, severity: 'warning' },
                    { file: 'b.ts', line: 20, severity: 'error' },
                ],
            },
            ['issues.file', 'issues.line'],
        );

        expect(result).toEqual({
            issues: [
                { file: 'a.ts', line: 10 },
                { file: 'b.ts', line: 20 },
            ],
        });
    });

    it('throws on invalid path syntax', () => {
        expect(() =>
            applyFieldMask({ summary: 'ok' }, ['issues..file']),
        ).toThrow('Invalid field path');
    });

    it('throws when path does not exist in payload', () => {
        expect(() =>
            applyFieldMask({ summary: 'ok' }, ['issues.file']),
        ).toThrow('Unknown field path');
    });

    it('throws when a nested array path is missing in any item', () => {
        expect(() =>
            applyFieldMask(
                {
                    issues: [{ file: 'a.ts', line: 10 }, { line: 20 }],
                },
                ['issues.file'],
            ),
        ).toThrow('Unknown field path');
    });
});
