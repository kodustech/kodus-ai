import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type { RuntimeRunRequested } from '@libs/runtime/run';

// Where a Run publishes, written by the PRODUCT when it enqueues the
// RuntimeRunRequested and before the outbox row (product Postgres,
// `runtime_run_targets`, §8: only the product writes). The publisher reads the
// target from here and nothing the Runtime wrote (its message or the
// `runtime_runs` projection) can move it to another org, repo, PR or SHA.

export const RUNTIME_RUN_TARGET_STORE_TOKEN = Symbol.for('RuntimeRunTargetStore');

export interface RunTarget {
    runId: string;
    attempt: number;
    organizationId: string;
    teamId: string;
    repositoryId: string;
    repositoryName: string;
    repositoryFullName?: string;
    platform: PlatformType;
    pullRequestNumber: number;
    headSha: string;
}

/**
 * Where the Run publishes, from a request the product built itself (Run
 * again, the PR trigger, the dev e2e standing in for it). Never from a
 * message the Runtime sent back.
 */
export function runTargetOf(request: RuntimeRunRequested, platform: PlatformType): RunTarget {
    return {
        runId: request.runId,
        attempt: request.attempt,
        organizationId: request.organizationId,
        teamId: request.teamId,
        repositoryId: request.repository.id,
        repositoryName: request.repository.name,
        ...(request.repository.fullName ? { repositoryFullName: request.repository.fullName } : {}),
        platform,
        pullRequestNumber: request.pullRequest.number,
        headSha: request.pullRequest.headSha,
    };
}

/** A second record for a runId that names another target. */
export class RunTargetConflictError extends Error {
    constructor(readonly runId: string) {
        super(`Run ${runId} already has another publish target`);
        this.name = 'RunTargetConflictError';
    }
}

export interface RunTargetStore {
    /** Idempotent for the same target; a different target for the same runId throws RunTargetConflictError. */
    record(target: RunTarget): Promise<void>;
    get(runId: string): Promise<RunTarget | null>;
}

const FIELDS: (keyof RunTarget)[] = [
    'runId',
    'attempt',
    'organizationId',
    'teamId',
    'repositoryId',
    'repositoryName',
    'repositoryFullName',
    'platform',
    'pullRequestNumber',
    'headSha',
];

export function sameRunTarget(a: RunTarget, b: RunTarget): boolean {
    return FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));
}

export class InMemoryRunTargetStore implements RunTargetStore {
    readonly rows = new Map<string, RunTarget>();

    async record(target: RunTarget): Promise<void> {
        const existing = this.rows.get(target.runId);
        if (existing && !sameRunTarget(existing, target)) {
            throw new RunTargetConflictError(target.runId);
        }
        this.rows.set(target.runId, { ...target });
    }

    async get(runId: string): Promise<RunTarget | null> {
        const row = this.rows.get(runId);
        return row ? { ...row } : null;
    }
}
