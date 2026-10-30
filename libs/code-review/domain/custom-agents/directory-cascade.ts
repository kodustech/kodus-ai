/** The two lists as the cascade layers hold them: stored deltas are only
 *  partly typed, so entries are read by their key alone. */
type AgentLists = {
    customAgents?: readonly unknown[];
    knowledge?: readonly unknown[];
};

/**
 * At a directory, the custom agents and their skills and docs add to the
 * lists the repository resolves to instead of replacing them, so a team
 * writing an agent for one folder keeps the repository's agents there too.
 * A directory entry with the id of an inherited agent (or the path of an
 * inherited knowledge item) takes its place: that is how a directory changes
 * an inherited agent or turns it off with `enabled: false`. Every other list
 * in the cascade is still replaced whole by deepMerge.
 *
 * `merged` is the full cascade, `inherited` the same cascade without the
 * directory, `directory` the directory's own stored delta.
 */
export function withDirectoryAgentLists<T extends object>(
    merged: T,
    inherited: AgentLists,
    directory: AgentLists | undefined,
): T {
    const result: T & AgentLists = { ...merged };
    if (Array.isArray(directory?.customAgents)) {
        result.customAgents = addOrReplace(
            inherited.customAgents,
            directory.customAgents,
            (agent) => (agent as { id?: string } | undefined)?.id,
        );
    }
    if (Array.isArray(directory?.knowledge)) {
        result.knowledge = addOrReplace(
            inherited.knowledge,
            directory.knowledge,
            (item) => (item as { path?: string } | undefined)?.path,
        );
    }
    return result;
}

/** `inherited` with each entry `own` shares a key with swapped in place,
 *  then the rest of `own` in its order. */
function addOrReplace<T>(
    inherited: readonly T[] | undefined,
    own: readonly T[],
    keyOf: (entry: T) => string | undefined,
): T[] {
    const ownByKey = new Map(
        own
            .filter((entry) => keyOf(entry))
            .map((entry) => [keyOf(entry), entry]),
    );
    const replaced = new Set<T>();
    const result = (Array.isArray(inherited) ? inherited : []).map((entry) => {
        const mine = ownByKey.get(keyOf(entry));
        if (!mine) return entry;
        replaced.add(mine);
        return mine;
    });
    return [...result, ...own.filter((entry) => !replaced.has(entry))];
}
