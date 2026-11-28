const BRANCH_REF = 'refs/heads/';

export interface DefaultBranchPush {
    branch: string;
    after: string;
}

/**
 * A push that moved the repository's default branch (docs/runtime/fork-from-checkpoint.md R6), as far as the payload
 * says: a branch ref (never a tag), not a deletion, on the repository's own default branch, of a repository that is not
 * a fork. A first filter only: the Runtime reads the default branch and its head from the Git API before it acts.
 */
export function defaultBranchPushOf(
    event: string,
    payload:
        | {
              ref?: string;
              after?: string;
              deleted?: boolean;
              repository?: { default_branch?: string; fork?: boolean };
          }
        | undefined,
): DefaultBranchPush | null {
    const ref = payload?.ref;
    const branch = ref?.startsWith(BRANCH_REF) ? ref.slice(BRANCH_REF.length) : '';
    if (
        event !== 'push' ||
        !branch ||
        payload?.deleted === true ||
        payload?.repository?.fork === true ||
        payload?.repository?.default_branch !== branch ||
        typeof payload?.after !== 'string' ||
        !/^[0-9a-f]{40}$/.test(payload.after) ||
        /^0+$/.test(payload.after)
    ) {
        return null;
    }
    return { branch, after: payload.after };
}
