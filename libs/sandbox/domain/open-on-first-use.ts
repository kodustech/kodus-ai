/**
 * Something opened by its first use, not before (#2629): a conversation turn
 * opens its sandbox on the agent's first repository tool call, so a turn that
 * never reads the repository starts, resumes and fetches nothing.
 *
 * Every later or concurrent `open()` gets the first call's promise, so the
 * parallel first reads of one step share one open. `settled()` is for whoever
 * releases it: undefined when nothing opened, otherwise the open's outcome,
 * waited for when the turn ends while it is still in flight.
 */
export interface OpenOnFirstUse<T> {
    open(): Promise<T>;
    settled(): Promise<T | undefined>;
}

export function openOnFirstUse<T>(open: () => Promise<T>): OpenOnFirstUse<T> {
    let opening: Promise<T> | undefined;
    return {
        open: () => (opening ??= open()),
        settled: async () => (opening ? await opening : undefined),
    };
}
