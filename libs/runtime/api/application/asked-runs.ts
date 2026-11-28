import { HttpException, HttpStatus } from '@nestjs/common';

import type { RunProjectionReader } from '@libs/runtime/run';

import { COMMENT_RUNS_PER_PULL_REQUEST_PER_DAY } from '../domain/trigger-rules';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The ways a person asks for a Run by hand: `@kody runtime` comments, and
 * Run again or "Run on this PR" from Kodus (both `run_again`). They share one
 * count per pull request and environment, and one limit.
 */
const ASKED_RUN_TRIGGERS = ['comment', 'run_again'] as const;

/** What a refusal at the daily count says, wherever the Run was asked from. */
export const ASKED_RUNS_REACHED_DETAIL = `This pull request already had ${COMMENT_RUNS_PER_PULL_REQUEST_PER_DAY} Runs asked by hand (@kody runtime, Run again or Run on this PR) in the last 24 hours; ask again later.`;

/** Whether the pull request already had the day's Runs asked by hand in this environment. */
export async function askedRunsReached(
    runs: Pick<RunProjectionReader, 'list'>,
    key: { organizationId: string; repositoryId: string; prNumber: number },
    environmentId: string,
    now: number = Date.now(),
): Promise<boolean> {
    const requestedSince = new Date(now - DAY_MS).toISOString();
    const limit = COMMENT_RUNS_PER_PULL_REQUEST_PER_DAY;
    // One read per trigger: Runs started another way (every push) never push asked ones out of a page.
    const counts = await Promise.all(
        ASKED_RUN_TRIGGERS.map(async (trigger) =>
            (await runs.list({ ...key, environmentId, trigger, requestedSince, limit })).filter((r) => r.environmentId === environmentId && r.trigger === trigger).length,
        ),
    );
    return counts.reduce((a, b) => a + b, 0) >= limit;
}

/** 429 for a Run asked from Kodus past the daily count. */
export const askedRunsReachedError = () =>
    new HttpException({ statusCode: HttpStatus.TOO_MANY_REQUESTS, code: 'asked_runs_per_day_reached', message: ASKED_RUNS_REACHED_DETAIL }, HttpStatus.TOO_MANY_REQUESTS);
