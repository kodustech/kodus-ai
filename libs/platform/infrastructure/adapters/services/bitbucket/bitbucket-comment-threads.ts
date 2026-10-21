type BitbucketComment = {
    id: number | string;
    parent?: { id: number | string } | null;
    created_on?: string;
    replies?: BitbucketComment[];
    [key: string]: unknown;
};

/**
 * Sets `replies` on each Bitbucket comment. An intermediate reply lists its
 * direct children; a thread's root lists every comment under it, replies to
 * replies included, in creation order. Bitbucket nests replies without limit,
 * and feedback or a conversation under Kody's prompt reply belongs to the
 * finding's thread. Order of the input does not matter.
 */
export function attachRepliesToComments<T extends BitbucketComment>(
    comments: T[],
): Array<T & { replies: T[] }> {
    const byId = new Map<string, T & { replies: T[] }>();
    for (const comment of comments) {
        byId.set(String(comment.id), Object.assign(comment, { replies: [] as T[] }));
    }

    const rootOf = (comment: T): (T & { replies: T[] }) | undefined => {
        let current = comment;
        const seen = new Set<string>();
        while (current.parent && byId.has(String(current.parent.id))) {
            if (seen.has(String(current.id))) return undefined;
            seen.add(String(current.id));
            current = byId.get(String(current.parent.id));
        }
        return current === comment ? undefined : byId.get(String(current.id));
    };

    const time = (x: T) => new Date(x.created_on ?? 0).getTime();
    const ordered = [...byId.values()].sort((a, b) => time(a) - time(b));

    for (const comment of ordered) {
        const parent = comment.parent
            ? byId.get(String(comment.parent.id))
            : undefined;
        if (!parent) continue;
        const root = rootOf(comment);
        if (root && root !== parent) root.replies.push(comment);
        parent.replies.push(comment);
    }

    return comments as Array<T & { replies: T[] }>;
}
