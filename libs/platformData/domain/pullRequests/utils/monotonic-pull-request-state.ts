import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';

import { IPullRequestTerminalState } from '../interfaces/pullRequests.interface';

type PullRequestStateSnapshot = Partial<IPullRequestTerminalState>;

export function isTerminalPullRequestState(
    state: PullRequestStateSnapshot,
): boolean {
    return (
        state.merged === true ||
        state.status === PullRequestState.CLOSED ||
        state.status === PullRequestState.MERGED
    );
}

/**
 * Terminal state is monotonic: an older/open webhook may enrich review data,
 * but it must never reopen a PR that a newer event or reconciliation already
 * proved closed at the provider.
 */
export function resolveMonotonicPullRequestState(
    current: PullRequestStateSnapshot,
    incoming: PullRequestStateSnapshot,
): PullRequestStateSnapshot {
    const currentIsTerminal = isTerminalPullRequestState(current);
    const incomingIsTerminal = isTerminalPullRequestState(incoming);

    if (currentIsTerminal && !incomingIsTerminal) {
        return {
            status: current.status,
            merged: current.merged,
            closedAt: current.closedAt,
        };
    }

    if (currentIsTerminal && incomingIsTerminal) {
        return {
            status:
                current.status === PullRequestState.MERGED ||
                incoming.status === PullRequestState.MERGED
                    ? PullRequestState.MERGED
                    : PullRequestState.CLOSED,
            merged: current.merged === true || incoming.merged === true,
            closedAt: current.closedAt || incoming.closedAt || '',
        };
    }

    return incoming;
}
