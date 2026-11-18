import type { RuntimeRunSummary } from "../contracts";
import { durationBetween, formatDurationMs } from "../format";
import {
    isCheckFinal,
    isTerminalRunState,
    runStateLabel,
    runStateTone,
    type Tone,
} from "../labels";

// One row of the Runs list, read by a leader scanning: the verdict once,
// what the check adds to it, how long it took. The check title often repeats
// the state ("Partly tested" next to a "Partly tested" chip), so only the
// part it adds is kept.

export type RunListRow = {
    /** What the row is named by: the PR's title as the Run recorded it; absent on older Runs, which keep "#n". */
    prTitle?: string;
    verdict: { label: string; tone: Tone };
    /** What the check says beyond the verdict ("3 blocked outbound requests"). */
    detail?: string;
    /** "attempt 2", from the second attempt on. */
    attempt?: string;
    /** A measured time is data (mono); "Running" and "Not started" are words. */
    duration: { text: string; measured: boolean };
};

const SEPARATOR = /^\s*(?:·|:|-|\u2014)\s*/;

const checkDetail = (run: RuntimeRunSummary, label: string) => {
    if (!run.check || !isCheckFinal(run.state)) return undefined;
    const title = run.check.title.trim();
    if (!title) return undefined;
    if (title.toLowerCase() === label.toLowerCase()) return undefined;
    if (title.toLowerCase().startsWith(label.toLowerCase())) {
        const rest = title.slice(label.length);
        if (SEPARATOR.test(rest))
            return rest.replace(SEPARATOR, "") || undefined;
        // "No regressions in what was tested": the state again, in a sentence.
        if (/^\s/.test(rest)) return undefined;
    }
    return title;
};

export const runListRow = (run: RuntimeRunSummary): RunListRow => {
    const label = runStateLabel(run.state);
    const duration = isTerminalRunState(run.state)
        ? {
              text: formatDurationMs(
                  durationBetween(
                      run.startedAt ?? run.requestedAt,
                      run.finishedAt,
                  ),
              ),
              measured: true,
          }
        : {
              text:
                  run.state === "booting" || run.state === "testing"
                      ? "Running"
                      : "Not started",
              measured: false,
          };
    return {
        prTitle: run.prTitle?.trim() || undefined,
        verdict: { label, tone: runStateTone(run.state) },
        detail: checkDetail(run, label),
        attempt: run.attempt > 1 ? `attempt ${run.attempt}` : undefined,
        duration,
    };
};
