// GitHub's merge queue tests each queued PR on a temporary branch named
// gh-readonly-queue/<base branch>/pr-<number>-<base sha>.
const MERGE_QUEUE_REF =
    /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-(\d+)-[0-9a-f]{40}$/;

export interface MergeQueueRef {
    prNumber: number;
    baseBranch: string;
}

export function parseMergeQueueRef(ref?: string | null): MergeQueueRef | null {
    const match = ref ? MERGE_QUEUE_REF.exec(ref) : null;
    if (!match) {
        return null;
    }

    return { baseBranch: match[1], prNumber: Number(match[2]) };
}

/** A push that created or updated a merge queue branch (not its deletion). */
export function isMergeQueuePush(
    event: string,
    payload: { ref?: string; deleted?: boolean } | undefined,
): boolean {
    return (
        event === 'push' &&
        payload?.deleted !== true &&
        parseMergeQueueRef(payload?.ref) !== null
    );
}
