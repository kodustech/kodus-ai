import type {
    BusinessValidationResponse,
    PullRequestSuggestionsResponse,
    ReviewConfig,
    ReviewResult,
    TrialReviewResult,
} from '../../types/review.js';
import type { GitMetrics, IReviewApi } from './api.interface.js';
import { requestWithRetry } from './api-core.js';
import { CommandError } from '../../utils/command-errors.js';

type RequestWithRetry = <T>(
    endpoint: string,
    options?: RequestInit,
) => Promise<T>;

interface CliReviewEnqueueResponse {
    jobId: string;
    status: string;
    statusUrl?: string;
}

interface CliReviewJobStatusResponse {
    jobId: string;
    status:
        | 'PENDING'
        | 'PROCESSING'
        | 'COMPLETED'
        | 'FAILED'
        | 'WAITING_FOR_EVENT';
    result?: ReviewResult;
    error?: string;
    createdAt?: string;
    startedAt?: string;
    completedAt?: string;
}

const POLL_MIN_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 5_000;
const POLL_MAX_WAIT_MS = 30 * 60 * 1000;

// Match the API contract exactly. The DTO caps the raw diff by character
// count (@MaxLength(20000000) — apps/api/src/dtos/cli-review.dto.ts) and the
// server body-parser caps the whole request at 25mb (apps/api/src/main.ts).
// A serialized-body cap alone would hard-fail valid payloads (JSON escaping
// or config.files push a valid diff's body just past a 20MiB threshold), so
// guard on diff.length for the DTO cap and keep a byte guard with margin
// under the parser cap. Working-tree reviews inline full file contents, so
// large changesets can blow past this — fail fast with a clear message
// instead of letting a gateway/WAF turn it into an opaque 403.
const MAX_DIFF_CHARS = 20_000_000; // matches DTO @MaxLength(20000000)
const MAX_SERIALIZED_BODY_BYTES = 24 * 1024 * 1024; // margin under the 25mb body parser

export class RealReviewApi implements IReviewApi {
    constructor(private readonly requester: RequestWithRetry = requestWithRetry) {}

    async analyze(
        diff: string,
        accessToken: string,
        config?: ReviewConfig,
    ): Promise<ReviewResult> {
        return this.analyzeWithMetrics(diff, accessToken, config);
    }

    async analyzeWithMetrics(
        diff: string,
        accessToken: string,
        config?: ReviewConfig,
        metrics?: GitMetrics,
        onProgress?: (status: string) => void,
    ): Promise<ReviewResult> {
        const isTeamKey = accessToken.startsWith('kodus_');

        const authHeaders: Record<string, string> = isTeamKey
            ? { 'X-Team-Key': accessToken }
            : { Authorization: `Bearer ${accessToken}` };

        // Personal tokens: do NOT pass `teamId` here. Earlier we forwarded
        // the JWT's organizationId in this query param, which the backend's
        // `resolveOrgAndTeamForReview` would feed to `teamService.findById`
        // — that lookup obviously fails (org id is not a team id) and
        // succeeded today only because of a downstream fallback to
        // `findFirstCreatedTeam(orgId)`. Letting the backend take that
        // fallback directly keeps the flow correct without lying about
        // the parameter's meaning.
        const endpoint = '/cli/review';

        const body = JSON.stringify({ diff, config, ...metrics });
        const payloadBytes = Buffer.byteLength(body, 'utf8');
        if (diff.length > MAX_DIFF_CHARS) {
            throw new CommandError(
                'REVIEW_TOO_LARGE',
                `Diff is too large (${diff.length.toLocaleString()} characters, limit ${MAX_DIFF_CHARS.toLocaleString()}). Narrow the review scope.`,
            );
        }
        if (payloadBytes > MAX_SERIALIZED_BODY_BYTES) {
            throw new CommandError(
                'REVIEW_TOO_LARGE',
                `Review payload is too large (${(payloadBytes / (1024 * 1024)).toFixed(1)}MB, limit ${MAX_SERIALIZED_BODY_BYTES / (1024 * 1024)}MB). Narrow the review scope or use --branch, --commit, or --fast, which avoid inlining file contents.`,
            );
        }

        // Enqueue: server returns 202 + jobId. We then poll for completion.
        const enqueueResponse = await this.requester<CliReviewEnqueueResponse>(
            endpoint,
            {
                method: 'POST',
                headers: {
                    ...authHeaders,
                    'X-Kodus-Async': '1',
                },
                body,
            },
        );

        if (!enqueueResponse?.jobId) {
            // Server didn't honor async (older deployment). It must have
            // returned the legacy synchronous body, so just hand it back.
            return enqueueResponse as unknown as ReviewResult;
        }

        return this.pollReviewJob(
            enqueueResponse.jobId,
            authHeaders,
            onProgress,
        );
    }

    private async pollReviewJob(
        jobId: string,
        authHeaders: Record<string, string>,
        onProgress?: (status: string) => void,
    ): Promise<ReviewResult> {
        const startedAt = Date.now();
        let delayMs = POLL_MIN_DELAY_MS;
        let lastStatus: string | undefined;

        while (Date.now() - startedAt < POLL_MAX_WAIT_MS) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            delayMs = Math.min(delayMs * 2, POLL_MAX_DELAY_MS);

            const statusResponse =
                await this.requester<CliReviewJobStatusResponse>(
                    `/cli/review/jobs/${encodeURIComponent(jobId)}`,
                    { method: 'GET', headers: { ...authHeaders } },
                );

            if (statusResponse.status !== lastStatus) {
                lastStatus = statusResponse.status;
                onProgress?.(statusResponse.status);
            }

            if (statusResponse.status === 'COMPLETED') {
                if (!statusResponse.result) {
                    throw new Error(
                        `CLI review job ${jobId} completed but no result was returned`,
                    );
                }
                return statusResponse.result;
            }

            if (statusResponse.status === 'FAILED') {
                throw new Error(
                    statusResponse.error ||
                        `CLI review job ${jobId} failed without an error message`,
                );
            }
        }

        throw new Error(
            `CLI review job ${jobId} did not finish within ${POLL_MAX_WAIT_MS}ms`,
        );
    }

    async getPullRequestSuggestions(
        accessToken: string,
        params: {
            prUrl?: string;
            prNumber?: number;
            repositoryId?: string;
            format?: 'markdown';
            severity?: string;
            category?: string;
        },
    ): Promise<PullRequestSuggestionsResponse> {
        const query = new URLSearchParams();

        if (params.prUrl) {
            query.set('prUrl', params.prUrl);
        }

        if (params.prNumber !== undefined) {
            query.set('prNumber', params.prNumber.toString());
        }

        if (params.repositoryId) {
            query.set('repositoryId', params.repositoryId);
        }

        if (params.format) {
            query.set('format', params.format);
        }

        if (params.severity) {
            query.set('severity', params.severity);
        }

        if (params.category) {
            query.set('category', params.category);
        }

        const queryString = query.toString();
        const endpoint = `/pull-requests/suggestions${queryString ? `?${queryString}` : ''}`;
        const isTeamKey = accessToken.startsWith('kodus_');

        return this.requester<PullRequestSuggestionsResponse>(endpoint, {
            headers: {
                ...(isTeamKey
                    ? { 'X-Team-Key': accessToken }
                    : { Authorization: `Bearer ${accessToken}` }),
            },
        });
    }

    async triggerBusinessValidation(
        accessToken: string,
        params: {
            repository?: string;
            taskUrl?: string;
            taskId?: string;
            diff?: string;
        },
    ): Promise<BusinessValidationResponse> {
        const isTeamKey = accessToken.startsWith('kodus_');
        const body: Record<string, unknown> = {};

        if (params.repository) {
            body.repository = params.repository;
        }
        if (params.taskUrl) {
            body.taskUrl = params.taskUrl;
        }
        if (params.taskId) {
            body.taskId = params.taskId;
        }
        if (params.diff) {
            body.diff = params.diff;
        }

        return this.requester<BusinessValidationResponse>(
            '/cli/business-validation',
            {
                method: 'POST',
                headers: {
                    ...(isTeamKey
                        ? { 'X-Team-Key': accessToken }
                        : { Authorization: `Bearer ${accessToken}` }),
                },
                body: JSON.stringify(body),
            },
        );
    }

    async trialAnalyze(
        diff: string,
        fingerprint: string,
        metrics?: GitMetrics,
        githubPat?: string,
    ): Promise<TrialReviewResult> {
        return this.requester<TrialReviewResult>('/cli/trial/review', {
            method: 'POST',
            body: JSON.stringify({
                diff,
                fingerprint,
                ...metrics,
                ...(githubPat && { githubPat }),
            }),
        });
    }
}
