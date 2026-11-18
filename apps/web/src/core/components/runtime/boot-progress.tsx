"use client";

import { useEffect, useState } from "react";
import type {
    SetupLastActive,
    SetupProgress,
} from "@services/runtime/contracts";
import { formatDurationMs } from "@services/runtime/format";
import { bootPhaseLabel } from "@services/runtime/labels";

import { RelativeTime } from "./relative-time";
import { StatusChip } from "./status-chip";

/** Milliseconds since `since`, ticking every second while `live`. */
export const useElapsed = (since: string | undefined, live: boolean) => {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!live) return;
        const t = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(t);
    }, [live]);
    return since ? Math.max(0, now - Date.parse(since)) : undefined;
};

/**
 * The boot as the cell reports it while it runs: each machine phase with its
 * time, and the running one's last lines (a build's output), so a long boot
 * never looks stuck.
 */
export const BootProgress = ({
    progress,
    live,
    last,
}: {
    progress: SetupProgress;
    live: boolean;
    /** The last setup that became active, to say what to expect. */
    last?: SetupLastActive;
}) => {
    const running = progress.phases.find((p) => p.state === "started");
    const elapsed = useElapsed(running?.at, live && !!running);
    const usual = (phase: string) =>
        last?.phases.find((p) => p.phase === phase)?.ms;
    return (
        <div className="border-card-lv3 ml-2 flex flex-col gap-2 border-l pl-4">
            {last && (
                <p className="text-text-secondary text-xs">
                    The last setup that booted took{" "}
                    <span className="font-mono">
                        {formatDurationMs(last.totalMs)}
                    </span>{" "}
                    (<RelativeTime at={last.finishedAt} />
                    ).
                </p>
            )}
            <ol className="flex flex-col gap-1" aria-label="Boot phases">
                {progress.phases.map((p) => (
                    <li
                        key={p.phase}
                        className="flex items-center gap-3 text-xs">
                        <StatusChip
                            tone={p.state === "done" ? "success" : "info"}>
                            {p.state === "done"
                                ? "Done"
                                : live
                                  ? "Running"
                                  : "Stopped"}
                        </StatusChip>
                        <span className="text-text-primary w-36">
                            {bootPhaseLabel(p.phase)}
                        </span>
                        <span className="text-text-tertiary font-mono">
                            {p.state === "done"
                                ? formatDurationMs(p.ms)
                                : live
                                  ? formatDurationMs(elapsed)
                                  : ""}
                        </span>
                        {usual(p.phase) !== undefined && (
                            <span
                                className={
                                    p.state !== "done" &&
                                    live &&
                                    elapsed !== undefined &&
                                    elapsed > 2 * usual(p.phase)!
                                        ? "text-warning"
                                        : "text-text-tertiary"
                                }>
                                last time {formatDurationMs(usual(p.phase))}
                            </span>
                        )}
                    </li>
                ))}
            </ol>
            {progress.lines.length > 0 && (
                <pre
                    aria-label={live ? "Live output" : "Last output"}
                    className="bg-card-lv1 max-h-56 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap">
                    {progress.lines.join("\n")}
                </pre>
            )}
            {live && (
                <p className="text-text-tertiary text-xs">
                    Updated <RelativeTime at={progress.updatedAt} />
                </p>
            )}
        </div>
    );
};
