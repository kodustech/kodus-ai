import type { PullRequestReviewRun } from '../types/pr-reviews.js';
import { CommandError } from '../utils/command-errors.js';
import { pullRequestsApi } from './api/pull-requests.api.js';
import { gitService } from './git.service.js';
import { userContextService } from './user-context.service.js';

export type PullRequestReviewsInput = {
    prNumber: number;
    /** Repository id, as Kodus stores it. Wins over `repository`. */
    repositoryId?: string;
    /** `owner/repo` or the repository name; defaults to this checkout's origin. */
    repository?: string;
    team?: string;
    /** Most recent runs to return. */
    limit?: number;
};

export type PullRequestReviewsResult = {
    prNumber: number;
    repository: string;
    team: string;
    runs: PullRequestReviewRun[];
    /** True when more runs exist than `limit` returned. */
    truncated: boolean;
};

const PAGE_SIZE = 20;
const DEFAULT_LIMIT = 20;
// The API serves at most 100 runs per page (enriched-pull-requests-query.dto.ts).
const MAX_LIMIT = 100;

function runTime(run: PullRequestReviewRun): number {
    const stamp = run.automationExecution?.createdAt;
    const time = stamp ? Date.parse(stamp) : NaN;
    return Number.isFinite(time) ? time : 0;
}

class PullRequestReviewsService {
    async list(
        input: PullRequestReviewsInput,
    ): Promise<PullRequestReviewsResult> {
        if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) {
            throw new CommandError(
                'INVALID_INPUT',
                'Pull request number must be a positive integer.',
            );
        }
        const limit = input.limit ?? DEFAULT_LIMIT;
        if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
            throw new CommandError(
                'INVALID_INPUT',
                `--limit must be an integer from 1 to ${MAX_LIMIT}.`,
            );
        }

        const ctx = await userContextService.resolve(
            'Pull request review history',
            { team: input.team },
        );
        const repositoryId = input.repositoryId?.trim() || undefined;
        const repositoryName = repositoryId
            ? undefined
            : await this.resolveRepositoryName(input.repository);

        const runs: PullRequestReviewRun[] = [];
        let cursor: string | undefined;
        let hasMore = true;

        // Cursor paging, as the web PR page does: a page can return fewer rows
        // than it read, so `nextCursor` (not the page number) is the resume point.
        while (hasMore && runs.length <= limit) {
            const page = await pullRequestsApi.getExecutions(ctx.accessToken, {
                teamId: ctx.teamId,
                repositoryId,
                repositoryName,
                pullRequestNumber: input.prNumber,
                limit: PAGE_SIZE,
                cursor,
            });
            runs.push(
                ...(page?.data ?? []).filter(
                    (run) => run.prNumber === input.prNumber,
                ),
            );
            cursor = page?.pagination?.nextCursor;
            hasMore = !!page?.pagination?.hasNextPage && !!cursor;
        }

        runs.sort((a, b) => runTime(b) - runTime(a));

        return {
            prNumber: input.prNumber,
            repository: repositoryId ?? repositoryName ?? '',
            team: ctx.teamName,
            runs: runs.slice(0, limit),
            truncated: runs.length > limit || hasMore,
        };
    }

    private async resolveRepositoryName(repository?: string): Promise<string> {
        const explicit = repository?.trim().replace(/^\/+|\/+$/g, '');
        if (explicit) {
            return explicit;
        }

        const orgRepo = (await gitService.isGitRepository())
            ? await gitService.extractOrgRepo()
            : null;
        if (!orgRepo) {
            throw new CommandError(
                'INVALID_INPUT',
                'Could not tell which repository this is. Pass --repo <owner/repo> or --repo-id <id>.',
            );
        }
        return `${orgRepo.org}/${orgRepo.repo}`;
    }
}

export const pullRequestReviewsService = new PullRequestReviewsService();
