import { describe, expect, it } from 'vitest';
import { markdownFormatter } from '../markdown.js';
import type { ReviewResult } from '../../types/review.js';

describe('markdown formatter', () => {
    const result: ReviewResult = {
        summary: 'Found 4 issues',
        issues: (['info', 'error', 'critical', 'warning'] as const).map(
            (severity) => ({
                file: 'a.ts',
                line: 1,
                severity,
                message: `${severity} issue`,
            }),
        ),
        filesAnalyzed: 1,
        duration: 0,
    };

    it('counts every severity with critical above errors', () => {
        const output = markdownFormatter.format(result);

        expect(output).toContain(
            '| 🔴 Critical | 1 |\n| 🔴 Errors | 1 |\n| 🟡 Warnings | 1 |\n| 🔵 Info | 1 |',
        );
    });

    it('renders every issue in severity order with critical first', () => {
        const output = markdownFormatter.format(result);
        const issuesSection = output.split('## Issues\n')[1];

        expect(issuesSection).toBeDefined();
        expect(issuesSection.match(/^### .+$/gm)).toEqual([
            '### 🔴 CRITICAL: a.ts:1',
            '### 🔴 ERROR: a.ts:1',
            '### 🟡 WARNING: a.ts:1',
            '### 🔵 INFO: a.ts:1',
        ]);
        for (const issue of result.issues) {
            expect(issuesSection).toContain(issue.message);
        }
    });

    it('renders a critical-only review instead of the empty block', () => {
        const output = markdownFormatter.format({
            ...result,
            issues: [
                {
                    file: 'a.ts',
                    line: 1,
                    severity: 'critical',
                    message: 'critical issue',
                },
            ],
        });

        expect(output).toContain('| 🔴 Critical | 1 |');
        expect(output).toContain('### 🔴 CRITICAL: a.ts:1');
    });
});
