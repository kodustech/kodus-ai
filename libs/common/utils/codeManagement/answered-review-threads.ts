import { isKodyPromptReply } from './bitbucket-suggestion-comment';

type ThreadId = string | number | null | undefined;

/** A review thread reduced to what "was it answered" needs. */
export interface ReviewThreadReplies {
    /** Every id the thread's root is stored under, e.g. note id and discussion id on GitLab. */
    rootIds: ThreadId[];
    /** The comments after the root, in any order. */
    replies: Array<{ body?: string | null }>;
}

/**
 * The root ids of the threads with at least one reply. Kody's Bitbucket
 * prompt reply is part of the finding, not an answer, so it does not count.
 */
export function answeredThreadRootIds(
    threads: ReviewThreadReplies[],
): Set<string> {
    const answered = new Set<string>();
    for (const thread of threads) {
        const hasReply = thread.replies.some(
            (reply) => !isKodyPromptReply(reply?.body),
        );
        if (!hasReply) continue;
        for (const id of thread.rootIds) {
            if (id !== undefined && id !== null && id !== '') {
                answered.add(String(id));
            }
        }
    }
    return answered;
}
