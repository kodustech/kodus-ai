import { describe, expect, it } from 'vitest';
import type { ReviewIssue, ReviewResult } from '../../types/review.js';
import {
    renderFileHeaderLines,
    renderFixPreviewLines,
    renderIssueDetailsLines,
    renderReviewSummaryLines,
} from '../interactive-renderers.js';

const issue: ReviewIssue = {
    file: 'src/app.ts',
    line: 15,
    severity: 'critical',
    message: 'Sanitize user input',
    category: 'security_vulnerability',
    ruleId: 'security.input',
    suggestion: 'Use a schema validator',
    recommendation: 'Validate and sanitize request payloads',
    fixable: true,
    fix: {
        line: 15,
        oldCode: 'const user = req.body',
        newCode: 'const user = schema.parse(req.body)',
    },
};

describe('renderIssueDetailsLines', () => {
    it('renders the important issue metadata and guidance', () => {
        const output = renderIssueDetailsLines(issue).join('\n');

        expect(output).toContain('Issue Details');
        expect(output).toContain('File: ');
        expect(output).toContain('src/app.ts');
        expect(output).toContain('Line: ');
        expect(output).toContain('15');
        expect(output).toContain('Category: ');
        expect(output).toContain('Rule: ');
        expect(output).toContain('Suggestion:');
        expect(output).toContain('Recommendation:');
        expect(output).toContain('Auto-fix available');
    });
});

describe('renderFixPreviewLines', () => {
    it('renders old and new code when a fix is available', () => {
        const output = renderFixPreviewLines(issue).join('\n');

        expect(output).toContain('Fix Preview');
        expect(output).toContain('- Old code:');
        expect(output).toContain('const user = req.body');
        expect(output).toContain('+ New code:');
        expect(output).toContain('const user = schema.parse(req.body)');
    });
});

describe('renderFileHeaderLines', () => {
    it('renders the selected file header with issue count', () => {
        const output = renderFileHeaderLines('src/app.ts', 2).join('\n');

        expect(output).toContain('src/app.ts');
        expect(output).toContain('2 issues in this file');
    });
});

describe('renderReviewSummaryLines', () => {
    it('renders the final review summary', () => {
        const result: ReviewResult = {
            summary: 'Review completed',
            filesAnalyzed: 3,
            issues: [issue, { ...issue, line: 22, file: 'src/lib.ts' }],
            duration: 123,
        };

        const output = renderReviewSummaryLines(result, 1).join('\n');

        expect(output).toContain('Review Summary');
        expect(output).toContain('Total issues: ');
        expect(output).toContain('2');
        expect(output).toContain('Fixed: ');
        expect(output).toContain('1');
        expect(output).toContain('Remaining: ');
        expect(output).toContain('1');
    });
});
