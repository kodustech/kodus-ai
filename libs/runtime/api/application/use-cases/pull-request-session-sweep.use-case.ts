import { createLogger } from '@libs/core/log/logger';

import type { RuntimePullRequestObserved } from '@libs/runtime/run';

// The fallback for a lost PR close (pr-sessions.ts in the worker): a session
// that holds a PR's code and is older than STALE_AFTER is checked against the
// PR's state, through the trigger's own close path. A PR the Git API says is
// closed or merged sends the close (its sessions go); one open again, or one
// the API cannot say, removes nothing. A PR of a repository with no Runtime
// environment cannot be read here: its sessions go at the cell's SessionTTL (24 h).

export const STALE_SESSION_HOURS = 2;

export interface StalePullRequest {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
}

export interface PullRequestSessionsReader {
    /** The PRs that have a session older than `before`, oldest first, at most `limit`. */
    stalePullRequests(before: Date, limit: number): Promise<StalePullRequest[]>;
}

export interface RepositoryResolver {
    environmentsOf(organizationId: string, repositoryId: string): Promise<Array<{ env: { teamId: string }; member: { repositoryName: string } }>>;
}

export interface CloseTrigger {
    execute(message: unknown): Promise<{ action: string; reason?: string }>;
}

export type SweepOutcome = { checked: number; closed: number; open: number; unknown: number };

export class RuntimePullRequestSessionSweep {
    private readonly logger = createLogger(RuntimePullRequestSessionSweep.name);

    constructor(
        private readonly sessions: PullRequestSessionsReader,
        private readonly repositories: RepositoryResolver,
        private readonly trigger: CloseTrigger,
        private readonly now: () => Date = () => new Date(),
        private readonly limit = 200,
    ) {}

    async run(): Promise<SweepOutcome> {
        const before = new Date(this.now().getTime() - STALE_SESSION_HOURS * 3_600_000);
        const prs = await this.sessions.stalePullRequests(before, this.limit);
        const out: SweepOutcome = { checked: prs.length, closed: 0, open: 0, unknown: 0 };
        for (const pr of prs) {
            const [first] = await this.repositories.environmentsOf(pr.organizationId, pr.repositoryId);
            if (!first) {
                out.unknown++;
                continue;
            }
            const event: RuntimePullRequestObserved = {
                organizationId: pr.organizationId,
                teamId: first.env.teamId,
                repository: { id: pr.repositoryId, name: first.member.repositoryName },
                prNumber: pr.prNumber,
                event: 'closed',
                labels: [],
                observedAt: this.now().toISOString(),
            };
            const r = await this.trigger.execute(event);
            // A close with no Run live still goes to the worker (nothing_live), which removes the sessions.
            if (r.action === 'cancelled' || r.reason === 'nothing_live') out.closed++;
            else if (r.reason === 'pr_still_open') out.open++;
            else out.unknown++;
        }
        if (prs.length) this.logger.log({ message: 'Runtime PR session sweep', context: RuntimePullRequestSessionSweep.name, metadata: out });
        return out;
    }
}
