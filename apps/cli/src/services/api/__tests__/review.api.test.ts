import { describe, expect, it, vi } from 'vitest';
import { RealReviewApi } from '../review.api.js';
import { CommandError } from '../../../utils/command-errors.js';

describe('RealReviewApi', () => {
    it('fails fast with REVIEW_TOO_LARGE before submitting an oversized payload', async () => {
        // Working-tree reviews inline full file contents, so a large
        // changeset can produce a body bigger than the API accepts. The CLI
        // must reject it client-side instead of letting a gateway/WAF turn
        // it into an opaque 403.
        const requestWithRetry = vi.fn();

        const oversizedDiff = 'd'.repeat(20 * 1024 * 1024 + 1);

        const api = new RealReviewApi(requestWithRetry);

        await expect(
            api.analyze(oversizedDiff, 'kodus_team_key'),
        ).rejects.toEqual(
            expect.objectContaining({
                name: 'CommandError',
                code: 'REVIEW_TOO_LARGE',
            } satisfies Partial<CommandError>),
        );

        expect(requestWithRetry).not.toHaveBeenCalled();
    });

    it('rejects an oversized serialized body even when the diff is under the character cap', async () => {
        // The DTO caps the raw diff by character count (@MaxLength 20M), not
        // by serialized bytes. A small diff with a large config.files (inlined
        // working-tree content) can still push the request body past the
        // server's 25mb body parser — guard on that separately.
        const requestWithRetry = vi.fn();

        const diff = 'd'.repeat(1024 * 1024);
        const config = {
            files: Array.from({ length: 30 }, (_, i) => ({
                path: `big${i}.txt`,
                content: 'c'.repeat(1024 * 1024),
                status: 'modified' as const,
                diff: '+1',
            })),
        };

        const api = new RealReviewApi(requestWithRetry);

        await expect(
            api.analyze(diff, 'kodus_team_key', config),
        ).rejects.toEqual(
            expect.objectContaining({
                name: 'CommandError',
                code: 'REVIEW_TOO_LARGE',
            } satisfies Partial<CommandError>),
        );

        expect(requestWithRetry).not.toHaveBeenCalled();
    });

    it('uses bearer auth without a teamId query for analyze with user token', async () => {
        // Personal tokens hit /cli/review with no teamId — the backend
        // resolves the team via findFirstCreatedTeam(orgId) from the JWT
        // claims. Sending the JWT's organizationId as a `teamId` query
        // param (the previous behavior) was a misuse of the parameter and
        // only worked because of a downstream fallback.
        const requestWithRetry = vi.fn().mockResolvedValue({
            summary: 'ok',
            issues: [],
            filesAnalyzed: 0,
            duration: 0,
        });

        const payload = Buffer.from(
            JSON.stringify({ organizationId: 'team-1' }),
        ).toString('base64url');
        const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;

        const api = new RealReviewApi(requestWithRetry);
        await api.analyze('diff --git a/file b/file', token);

        expect(requestWithRetry).toHaveBeenCalledWith('/cli/review', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Kodus-Async': '1',
            },
            body: JSON.stringify({
                diff: 'diff --git a/file b/file',
                config: undefined,
            }),
        });
    });

    it('uses X-Team-Key for pull request suggestions with team key auth', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            summary: 'ok',
            issues: [],
            filesAnalyzed: 0,
            duration: 0,
        });

        const api = new RealReviewApi(requestWithRetry);
        await api.getPullRequestSuggestions('kodus_team_key', {
            prUrl: 'https://github.com/acme/repo/pull/1',
            severity: 'high',
        });

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/pull-requests/suggestions?prUrl=https%3A%2F%2Fgithub.com%2Facme%2Frepo%2Fpull%2F1&severity=high',
            {
                headers: {
                    'X-Team-Key': 'kodus_team_key',
                },
            },
        );
    });

    it('serializes review context as a field separate from the diff', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            summary: 'ok',
            issues: [],
            filesAnalyzed: 1,
            duration: 1,
        });
        const reviewContext = {
            source: 'cli-review-context-file' as const,
            contentType: 'text/plain; charset=utf-8' as const,
            body: 'CANARY: audit abort cleanup',
        };
        const diff = 'diff --git a/file.ts b/file.ts\n+const value = 1;';

        const api = new RealReviewApi(requestWithRetry);
        await api.analyzeWithMetrics(
            diff,
            'kodus_team_key',
            undefined,
            undefined,
            undefined,
            reviewContext,
        );

        const request = requestWithRetry.mock.calls[0]?.[1] as
            { body?: string } | undefined;
        expect(JSON.parse(request?.body ?? '{}')).toEqual({
            diff,
            reviewContext,
        });
        expect(diff).not.toContain(reviewContext.body);
    });

    it('serializes review context separately for a trial review', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            summary: 'ok',
            issues: [],
            filesAnalyzed: 1,
            duration: 1,
        });
        const reviewContext = {
            source: 'cli-review-context-file' as const,
            contentType: 'text/plain; charset=utf-8' as const,
            body: 'trial-only context',
        };
        const api = new RealReviewApi(requestWithRetry);

        await api.trialAnalyze(
            'trial diff',
            'fingerprint',
            undefined,
            undefined,
            reviewContext,
        );

        const request = requestWithRetry.mock.calls[0]?.[1] as
            { body?: string } | undefined;
        expect(JSON.parse(request?.body ?? '{}')).toEqual({
            diff: 'trial diff',
            fingerprint: 'fingerprint',
            reviewContext,
        });
    });

    it('does not carry context into a later review when the option is omitted', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            summary: 'ok',
            issues: [],
            filesAnalyzed: 1,
            duration: 1,
        });
        const api = new RealReviewApi(requestWithRetry);
        const reviewContext = {
            source: 'cli-review-context-file' as const,
            contentType: 'text/plain; charset=utf-8' as const,
            body: 'first-review-only',
        };

        await api.analyzeWithMetrics(
            'first diff',
            'kodus_team_key',
            undefined,
            undefined,
            undefined,
            reviewContext,
        );
        await api.analyze('second diff', 'kodus_team_key');

        const secondRequest = requestWithRetry.mock.calls[1]?.[1] as
            { body?: string } | undefined;
        expect(JSON.parse(secondRequest?.body ?? '{}')).toEqual({
            diff: 'second diff',
        });
    });

    it('serializes only provided fields for business validation', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            status: 'ok',
        });

        const api = new RealReviewApi(requestWithRetry);
        await api.triggerBusinessValidation('kodus_team_key', {
            repository: 'kodustech/cli',
            taskId: 'TASK-1',
        });

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/cli/business-validation',
            {
                method: 'POST',
                headers: {
                    'X-Team-Key': 'kodus_team_key',
                },
                body: JSON.stringify({
                    repository: 'kodustech/cli',
                    taskId: 'TASK-1',
                }),
            },
        );
    });
});
