import { describe, expect, it } from 'vitest';
import type { ReviewIssue } from '../../types/review.js';
import {
    formatFileChoice,
    formatIssueTitle,
    getSeverityIcon,
} from '../interactive-formatters.js';

const issue: ReviewIssue = {
    file: 'src/app.ts',
    line: 12,
    severity: 'warning',
    message: 'Avoid unused values',
    category: 'code_quality',
    fixable: true,
    fix: {
        line: 12,
        oldCode: 'const unused = 1',
        newCode: '',
    },
};

describe('getSeverityIcon', () => {
    it('maps warning severity to the expected icon', () => {
        expect(getSeverityIcon('warning')).toBe('⚠️ ');
    });

    it('returns a bullet for unknown severity', () => {
        expect(getSeverityIcon('unknown')).toBe('•');
    });
});

describe('formatIssueTitle', () => {
    it('includes severity, location, message, and fixable badge', () => {
        const formatted = formatIssueTitle(issue);

        expect(formatted).toContain('WARNING');
        expect(formatted).toContain('src/app.ts:12');
        expect(formatted).toContain('Avoid unused values');
        expect(formatted).toContain('[fixable]');
    });
});

describe('formatFileChoice', () => {
    it('includes file path, severity counts, category badge, and fixable count', () => {
        const formatted = formatFileChoice('src/app.ts', [
            issue,
            {
                ...issue,
                line: 40,
                severity: 'critical',
                message: 'Critical issue',
                fixable: false,
                fix: undefined,
                category: 'security_vulnerability',
            },
        ]);

        expect(formatted).toContain('src/app.ts');
        expect(formatted).toContain('1 critical');
        expect(formatted).toContain('1 warning');
        expect(formatted).toContain('[quality, security]');
        expect(formatted).toContain('[1 fixable]');
    });
});
