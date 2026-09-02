import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';

import {
    isTerminalPullRequestState,
    resolveMonotonicPullRequestState,
} from './monotonic-pull-request-state';

describe('monotonic pull request state', () => {
    it('keeps a terminal state when a stale open event arrives', () => {
        expect(
            resolveMonotonicPullRequestState(
                {
                    status: PullRequestState.CLOSED,
                    merged: true,
                    closedAt: '2026-09-02T12:00:00.000Z',
                },
                {
                    status: PullRequestState.OPENED,
                    merged: false,
                    closedAt: '',
                },
            ),
        ).toEqual({
            status: PullRequestState.CLOSED,
            merged: true,
            closedAt: '2026-09-02T12:00:00.000Z',
        });
    });

    it('allows an open pull request to become terminal', () => {
        expect(
            resolveMonotonicPullRequestState(
                { status: PullRequestState.OPENED, merged: false },
                {
                    status: PullRequestState.CLOSED,
                    merged: false,
                    closedAt: '2026-09-02T12:00:00.000Z',
                },
            ),
        ).toEqual({
            status: PullRequestState.CLOSED,
            merged: false,
            closedAt: '2026-09-02T12:00:00.000Z',
        });
    });

    it('does not downgrade merged evidence when another terminal event arrives', () => {
        expect(
            resolveMonotonicPullRequestState(
                {
                    status: PullRequestState.CLOSED,
                    merged: true,
                    closedAt: '2026-09-02T12:00:00.000Z',
                },
                {
                    status: PullRequestState.CLOSED,
                    merged: false,
                    closedAt: '',
                },
            ),
        ).toEqual({
            status: PullRequestState.CLOSED,
            merged: true,
            closedAt: '2026-09-02T12:00:00.000Z',
        });
    });

    it('preserves an explicit merged status across terminal updates', () => {
        expect(
            resolveMonotonicPullRequestState(
                {
                    status: PullRequestState.MERGED,
                    merged: false,
                    closedAt: '2026-09-02T12:00:00.000Z',
                },
                {
                    status: PullRequestState.CLOSED,
                    merged: false,
                    closedAt: '2026-09-02T12:01:00.000Z',
                },
            ),
        ).toEqual({
            status: PullRequestState.MERGED,
            merged: false,
            closedAt: '2026-09-02T12:00:00.000Z',
        });
    });

    it('recognizes both merged flags and merged status as terminal', () => {
        expect(isTerminalPullRequestState({ merged: true })).toBe(true);
        expect(
            isTerminalPullRequestState({
                status: PullRequestState.MERGED,
                merged: false,
            }),
        ).toBe(true);
    });
});
