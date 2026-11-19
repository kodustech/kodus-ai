import { describe, expect, it } from 'vitest';
import {
    mapFileSuggestions,
    mapPrLevelSuggestions,
    normalizeReviewResult,
    normalizeSeverity,
    normalizeSuggestionsResponse,
} from '../review-normalizer.js';
import type {
    PullRequestSuggestionsResponse,
    ReviewResult,
    Severity,
} from '../../types/review.js';

describe('review normalizer', () => {
    it.each([
        ['high', 'error'],
        ['medium', 'warning'],
        ['low', 'info'],
    ])('normalizes issues-array severity %s to %s', (severity, expected) => {
        const issue = {
            file: 'a.ts',
            line: 10,
            endLine: 15,
            severity: severity as Severity,
            message: 'Fix this',
            suggestion: 'Fix summary',
            ruleId: 'security',
        };

        const result = normalizeSuggestionsResponse({ issues: [issue] });

        expect(result.issues).toEqual([{ ...issue, severity: expected }]);
    });

    it('normalizes severity in the flat suggestions-array branch', () => {
        const result = normalizeSuggestionsResponse({
            suggestions: [
                {
                    file: 'b.ts',
                    line: 5,
                    severity: 'high' as Severity,
                    message: 'style issue',
                },
            ],
        });

        expect(result.issues).toEqual([
            {
                file: 'b.ts',
                line: 5,
                severity: 'error',
                message: 'style issue',
            },
        ]);
    });

    it('treats a missing issues array as empty instead of crashing', () => {
        const result = normalizeReviewResult({
            summary: 'Found nothing',
            filesAnalyzed: 1,
            duration: 0,
        } as ReviewResult);

        expect(result.issues).toEqual([]);
        expect(result.summary).toBe('Found nothing');
    });

    it('normalizes every issue in a review result and keeps other fields', () => {
        const result = {
            summary: 'Found 2 issues',
            issues: [
                {
                    file: 'a.ts',
                    line: 1,
                    severity: 'high' as Severity,
                    message: 'a',
                },
                {
                    file: 'b.ts',
                    line: 2,
                    severity: 'medium' as Severity,
                    message: 'b',
                },
            ],
            filesAnalyzed: 2,
            duration: 10,
            notices: ['heavy mode'],
        };

        expect(normalizeReviewResult(result)).toEqual({
            ...result,
            issues: [
                { file: 'a.ts', line: 1, severity: 'error', message: 'a' },
                { file: 'b.ts', line: 2, severity: 'warning', message: 'b' },
            ],
        });
    });

    it('maps severities consistently', () => {
        expect(normalizeSeverity('critical')).toBe('critical');
        expect(normalizeSeverity('high')).toBe('error');
        expect(normalizeSeverity('error')).toBe('error');
        expect(normalizeSeverity('medium')).toBe('warning');
        expect(normalizeSeverity('warning')).toBe('warning');
        expect(normalizeSeverity('low')).toBe('info');
        expect(normalizeSeverity('info')).toBe('info');
        expect(normalizeSeverity(undefined)).toBe('info');
        expect(normalizeSeverity('something')).toBe('info');
        expect(normalizeSeverity('CRITICAL')).toBe('critical');
    });

    it('maps file suggestions', () => {
        expect(
            mapFileSuggestions([
                {
                    id: '1',
                    relevantFile: 'old.ts',
                    filePath: 'new.ts',
                    suggestionContent: 'Fix this',
                    oneSentenceSummary: 'Fix summary',
                    label: 'security',
                    severity: 'high',
                    relevantLinesStart: 10,
                    relevantLinesEnd: 15,
                },
            ]),
        ).toEqual([
            {
                file: 'new.ts',
                line: 10,
                endLine: 15,
                severity: 'error',
                message: 'Fix this',
                suggestion: 'Fix summary',
                ruleId: 'security',
            },
        ]);
    });

    it('maps PR-level suggestions', () => {
        expect(
            mapPrLevelSuggestions([
                {
                    id: '2',
                    suggestionContent: 'Improve PR description',
                    oneSentenceSummary: 'PR summary',
                    label: 'docs',
                    severity: 'low',
                },
            ]),
        ).toEqual([
            {
                file: 'PR',
                line: 0,
                severity: 'info',
                message: 'Improve PR description',
                suggestion: 'PR summary',
                ruleId: 'docs',
            },
        ]);
    });

    it('normalizes mixed suggestion responses', () => {
        const response: PullRequestSuggestionsResponse = {
            suggestions: {
                files: [
                    {
                        id: '1',
                        relevantFile: 'c.ts',
                        suggestionContent: 'Fix this',
                        oneSentenceSummary: 'Fix summary',
                        label: 'security',
                        severity: 'high',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 15,
                    },
                ],
                prLevel: [
                    {
                        id: '2',
                        suggestionContent: 'Improve PR description',
                        oneSentenceSummary: 'PR summary',
                        label: 'docs',
                        severity: 'low',
                    },
                ],
            },
        };

        const result = normalizeSuggestionsResponse(response);
        expect(result.summary).toBe('Pull request suggestions');
        expect(result.issues).toHaveLength(2);
        expect(result.filesAnalyzed).toBe(2);
        expect(result.duration).toBe(0);
    });
});

describe('review normalizer — full explanation', () => {
    it('prefers the full explanation over the short comment body', () => {
        const [file] = mapFileSuggestions([
            {
                id: '1',
                relevantFile: 'a.ts',
                suggestionContent: 'Short.',
                fullExplanation: 'The whole explanation.',
                oneSentenceSummary: 'Title',
                label: 'bug',
                severity: 'high',
                relevantLinesStart: 1,
            } as any,
        ]);
        const [pr] = mapPrLevelSuggestions([
            {
                id: '2',
                suggestionContent: 'Short PR.',
                fullExplanation: 'The whole PR explanation.',
                oneSentenceSummary: 'PR title',
                label: 'kody_rules',
                severity: 'low',
            } as any,
        ]);

        expect(file.message).toBe('The whole explanation.');
        expect(pr.message).toBe('The whole PR explanation.');
    });
});
