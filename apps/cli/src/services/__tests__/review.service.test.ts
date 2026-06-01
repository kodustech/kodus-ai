import { describe, it, expect, vi, afterEach } from 'vitest';
import { reviewService } from '../review.service.js';
import { api } from '../api/index.js';
import * as rateLimit from '../../utils/rate-limit.js';
import { setCliOutputMode } from '../../utils/logger.js';
import type { PullRequestSuggestionsResponse } from '../../types/review.js';
import { normalizeSuggestionsResponse } from '../review-normalizer.js';
import { filterReviewFiles } from '../review-file-filter.js';

describe('normalizeSeverity', () => {
    it('maps critical to critical', () => {
        expect(reviewService.normalizeSeverity('critical')).toBe('critical');
    });

    it('maps high to error', () => {
        expect(reviewService.normalizeSeverity('high')).toBe('error');
    });

    it('maps error to error', () => {
        expect(reviewService.normalizeSeverity('error')).toBe('error');
    });

    it('maps medium to warning', () => {
        expect(reviewService.normalizeSeverity('medium')).toBe('warning');
    });

    it('maps warning to warning', () => {
        expect(reviewService.normalizeSeverity('warning')).toBe('warning');
    });

    it('maps low to info', () => {
        expect(reviewService.normalizeSeverity('low')).toBe('info');
    });

    it('maps info to info', () => {
        expect(reviewService.normalizeSeverity('info')).toBe('info');
    });

    it('maps undefined to info', () => {
        expect(reviewService.normalizeSeverity(undefined)).toBe('info');
    });

    it('maps unknown string to info', () => {
        expect(reviewService.normalizeSeverity('something')).toBe('info');
    });

    it('is case-insensitive', () => {
        expect(reviewService.normalizeSeverity('CRITICAL')).toBe('critical');
        expect(reviewService.normalizeSeverity('High')).toBe('error');
        expect(reviewService.normalizeSeverity('WARNING')).toBe('warning');
    });
});

describe('normalizeSuggestionsResponse', () => {
    it('normalizes response with issues array', () => {
        const response: PullRequestSuggestionsResponse = {
            summary: 'Found issues',
            issues: [
                { file: 'a.ts', line: 1, severity: 'error', message: 'bug' },
            ],
            filesAnalyzed: 1,
            duration: 100,
        };

        const result = normalizeSuggestionsResponse(response);
        expect(result.summary).toBe('Found issues');
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].file).toBe('a.ts');
        expect(result.filesAnalyzed).toBe(1);
        expect(result.duration).toBe(100);
    });

    it('normalizes response with suggestions array', () => {
        const response: PullRequestSuggestionsResponse = {
            suggestions: [
                {
                    file: 'b.ts',
                    line: 5,
                    severity: 'warning',
                    message: 'style issue',
                },
            ],
        };

        const result = normalizeSuggestionsResponse(response);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].file).toBe('b.ts');
        expect(result.summary).toBe('Pull request suggestions');
    });

    it('normalizes response with suggestions object (files + prLevel)', () => {
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
        expect(result.issues).toHaveLength(2);

        const fileIssue = result.issues[0];
        expect(fileIssue.file).toBe('c.ts');
        expect(fileIssue.line).toBe(10);
        expect(fileIssue.endLine).toBe(15);
        expect(fileIssue.severity).toBe('error'); // high → error
        expect(fileIssue.message).toBe('Fix this');
        expect(fileIssue.suggestion).toBe('Fix summary');
        expect(fileIssue.ruleId).toBe('security');

        const prIssue = result.issues[1];
        expect(prIssue.file).toBe('PR');
        expect(prIssue.line).toBe(0);
        expect(prIssue.severity).toBe('info'); // low → info
        expect(prIssue.message).toBe('Improve PR description');
    });

    it('handles empty response', () => {
        const response: PullRequestSuggestionsResponse = {};

        const result = normalizeSuggestionsResponse(response);
        expect(result.issues).toHaveLength(0);
        expect(result.summary).toBe('Pull request suggestions');
        expect(result.filesAnalyzed).toBe(0);
        expect(result.duration).toBe(0);
    });

    it('uses filePath over relevantFile when available', () => {
        const response: PullRequestSuggestionsResponse = {
            suggestions: {
                files: [
                    {
                        id: '1',
                        relevantFile: 'old-path.ts',
                        filePath: 'new-path.ts',
                        suggestionContent: 'Fix',
                    },
                ],
            },
        };

        const result = normalizeSuggestionsResponse(response);
        expect(result.issues[0].file).toBe('new-path.ts');
    });
});

describe('filterFiles logging behavior', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not print skip warnings when quiet is enabled', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const oversizedDiff = 'x'.repeat(1024 * 1024 + 1);

        const result = filterReviewFiles(
            [
                {
                    path: 'big.ts',
                    content: 'const ok = true;',
                    status: 'modified',
                    diff: oversizedDiff,
                },
            ],
            true,
        );

        expect(result).toHaveLength(0);
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('prints skip warnings when quiet is disabled', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const oversizedDiff = 'x'.repeat(1024 * 1024 + 1);

        const result = filterReviewFiles(
            [
                {
                    path: 'big.ts',
                    content: 'const ok = true;',
                    status: 'modified',
                    diff: oversizedDiff,
                },
            ],
            false,
        );

        expect(result).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalled();
    });
});

describe('verbose logging mode', () => {
    afterEach(() => {
        setCliOutputMode({ quiet: false, verbose: false });
        reviewService.setVerbose(false);
        vi.restoreAllMocks();
    });

    it('suppresses verbose logs when quiet mode is enabled', async () => {
        vi.spyOn(rateLimit, 'getTrialIdentifier').mockResolvedValue(
            'fingerprint-test',
        );
        vi.spyOn(api.review, 'trialAnalyze').mockResolvedValue({
            summary: 'ok',
            issues: [],
            filesAnalyzed: 1,
            duration: 1,
        });

        setCliOutputMode({ quiet: true, verbose: true });
        reviewService.setVerbose(true);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await reviewService.trialAnalyze('diff content');

        expect(logSpy).not.toHaveBeenCalled();
    });
});
