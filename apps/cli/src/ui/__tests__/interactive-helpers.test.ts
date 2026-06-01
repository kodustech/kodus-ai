import { describe, expect, it } from 'vitest';
import type { ReviewIssue } from '../../types/review.js';
import {
    formatCategoryBadge,
    generateFixPrompt,
    generateFixPromptAll,
    getFileStats,
    getQuickFixEmptyMessage,
    groupIssuesByFile,
} from '../interactive-helpers.js';

const issues: ReviewIssue[] = [
    {
        file: 'src/app.ts',
        line: 10,
        severity: 'critical',
        message: 'Critical issue',
        category: 'security_vulnerability',
        suggestion: 'Validate input',
        recommendation: 'Add sanitization',
        fixable: false,
    },
    {
        file: 'src/app.ts',
        line: 22,
        severity: 'warning',
        message: 'Warning issue',
        category: 'code_quality',
        fixable: true,
        fix: {
            line: 22,
            oldCode: 'const x=1',
            newCode: 'const x = 1',
        },
    },
    {
        file: 'src/lib.ts',
        line: 5,
        severity: 'info',
        message: 'Info issue',
        fixable: false,
    },
];

describe('groupIssuesByFile', () => {
    it('groups issues by file path', () => {
        const grouped = groupIssuesByFile(issues);

        expect(Array.from(grouped.keys())).toEqual(['src/app.ts', 'src/lib.ts']);
        expect(grouped.get('src/app.ts')).toHaveLength(2);
        expect(grouped.get('src/lib.ts')).toHaveLength(1);
    });
});

describe('getFileStats', () => {
    it('counts issues by severity', () => {
        expect(getFileStats(issues)).toEqual({
            critical: 1,
            error: 0,
            warning: 1,
            info: 1,
        });
    });
});

describe('formatCategoryBadge', () => {
    it('maps known categories to compact labels', () => {
        expect(formatCategoryBadge('security_vulnerability')).toBe('security');
        expect(formatCategoryBadge('code_quality')).toBe('quality');
    });

    it('returns the original category when no alias exists', () => {
        expect(formatCategoryBadge('custom_category')).toBe('custom_category');
    });
});

describe('generateFixPrompt', () => {
    it('builds a readable prompt with issue details', () => {
        const prompt = generateFixPrompt('src/app.ts', issues.slice(0, 2));

        expect(prompt).toContain('Fix the following issues in src/app.ts:');
        expect(prompt).toContain('1. CRITICAL at line 10');
        expect(prompt).toContain('Critical issue');
        expect(prompt).toContain('Suggestion: Validate input');
        expect(prompt).toContain('Recommendation: Add sanitization');
        expect(prompt).toContain('2. WARNING at line 22');
        expect(prompt).toContain('Please fix these 2 issues in src/app.ts.');
    });
});

describe('generateFixPromptAll', () => {
    it('groups issues by file under section headers and totals correctly', () => {
        const grouped = groupIssuesByFile(issues);
        const prompt = generateFixPromptAll(grouped);

        expect(prompt).toContain(
            'Fix the following 3 issues across 2 files.',
        );
        expect(prompt).toContain('## File 1/2: src/app.ts (2 issues)');
        expect(prompt).toContain('## File 2/2: src/lib.ts (1 issue)');
        expect(prompt).toContain('1. CRITICAL at line 10');
        expect(prompt).toContain('Suggestion: Validate input');
        expect(prompt).toContain('1. INFO at line 5');
        expect(prompt).toContain(
            'Please apply all 3 fixes across the 2 files above.',
        );
    });

    it('uses singular wording when there is exactly one issue/file', () => {
        const grouped = groupIssuesByFile([issues[2]]);
        const prompt = generateFixPromptAll(grouped);

        expect(prompt).toContain(
            'Fix the following 1 issue across 1 file.',
        );
        expect(prompt).toContain('## File 1/1: src/lib.ts (1 issue)');
        expect(prompt).toContain(
            'Please apply all 1 fix across the 1 file above.',
        );
    });
});

describe('getQuickFixEmptyMessage', () => {
    it('returns a helpful message when no auto-fixable issues are present', () => {
        expect(getQuickFixEmptyMessage()).toBe(
            'No auto-fixable issues found. Try `kodus review --interactive` to inspect issues or run `kodus review` to see the full report.',
        );
    });
});
