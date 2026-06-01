import { describe, expect, it } from 'vitest';
import {
    mapFileSuggestions,
    mapPrLevelSuggestions,
    normalizeSeverity,
    normalizeSuggestionsResponse,
} from '../review-normalizer.js';
import type { PullRequestSuggestionsResponse } from '../../types/review.js';

describe('review normalizer', () => {
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
