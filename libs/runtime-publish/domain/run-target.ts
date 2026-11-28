import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type { WorkspaceRefSource } from '@libs/runtime/contracts/enums';
import type { RuntimeRunRequested } from '@libs/runtime/run';

// Where a Run publishes, written by the PRODUCT when it enqueues the
// RuntimeRunRequested and before the outbox row (product Postgres,
// `runtime_run_targets`: only the product writes). The publisher reads the
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
    /**
     * The commits every repository of a multi-repository environment ran at,
     * as the request pinned them: what the report names and what Run again
     * boots again. Absent for an environment of one repository.
     */
    workspace?: RunTargetWorkspaceRef[];
    /** The pull request comes from a fork: its PR side has no preview unless the org allows fork previews. Absent: not known (older targets). */
    fork?: boolean;
}

/** One repository of a Run's workspace as its target records it: no token, no name a later read could move. */
export interface RunTargetWorkspaceRef {
    repositoryId: string;
    alias: string;
    baseSha: string;
    headSha: string;
    source: WorkspaceRefSource;
    pairedPrNumber?: number;
    /** The branch its commits are of, when the request named it: what the report says it ran from. */
    branch?: string;
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
        ...(request.workspace ? { workspace: request.workspace.map(workspaceRefOf) } : {}),
        fork: request.pullRequest.fork,
    };
}

const workspaceRefOf = (r: NonNullable<RuntimeRunRequested['workspace']>[number]): RunTargetWorkspaceRef => ({
    repositoryId: r.repositoryId,
    alias: r.alias,
    baseSha: r.baseSha,
    headSha: r.headSha,
    source: r.source,
    ...(r.pairedPrNumber !== undefined ? { pairedPrNumber: r.pairedPrNumber } : {}),
    ...(r.branch !== undefined ? { branch: r.branch } : {}),
});

/** The refs in one canonical form (fixed key order, no absent key), or null when there are none: what two targets are compared by. */
export function canonicalWorkspace(refs: readonly RunTargetWorkspaceRef[] | null | undefined): string | null {
    if (!refs?.length) return null;
    return JSON.stringify(refs.map((r) => [r.repositoryId, r.alias, r.baseSha, r.headSha, r.source, r.pairedPrNumber ?? null, r.branch ?? null]));
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
    /**
     * The Run's target. With a scope, a target of another org reads as absent.
     * Without one (the publisher), the stored target is the authority on the org.
     */
    get(runId: string, scope?: RunTargetScope): Promise<RunTarget | null>;
}

/** The org a read of a Run's target is limited to. */
export interface RunTargetScope {
    organizationId: string;
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
    return FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null)) && canonicalWorkspace(a.workspace) === canonicalWorkspace(b.workspace);
}
