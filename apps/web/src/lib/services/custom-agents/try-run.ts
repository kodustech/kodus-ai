import type { CustomAgentTryTrace } from "./types";

export type TryRunView = {
    runId: string;
    status: "running" | "done";
    result?: CustomAgentTryTrace;
};

/** How often a started Try it run is read back. */
export const TRY_POLL_INTERVAL_MS = 4000;

/**
 * Reads a started run until it is done. A run on a large pull request takes
 * longer than one request may stay open, so the API answers with a run id
 * and keeps the trace for the poll.
 */
export const pollTryRun = async (
    started: TryRunView,
    readRun: (runId: string) => Promise<TryRunView>,
    wait: (ms: number) => Promise<void> = (ms) =>
        new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<CustomAgentTryTrace> => {
    let view = started;
    while (view.status !== "done" || !view.result) {
        await wait(TRY_POLL_INTERVAL_MS);
        view = await readRun(started.runId);
    }
    return view.result;
};
