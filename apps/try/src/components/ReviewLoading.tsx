"use client";

import { useEffect, useState } from "react";

const STAGES = [
    "Fetching diff from GitHub",
    "Cloning repo in sandbox",
    "Analyzing changes with Gemini",
    "Writing suggestions",
];

export function ReviewLoading({
    elapsedSeconds,
}: {
    elapsedSeconds: number;
}) {
    const [stageIdx, setStageIdx] = useState(0);

    useEffect(() => {
        const idx = Math.min(
            STAGES.length - 1,
            Math.floor(elapsedSeconds / 15),
        );
        setStageIdx(idx);
    }, [elapsedSeconds]);

    return (
        <div
            className="rounded-xl border border-[var(--border-strong)] bg-gradient-to-br from-[var(--bg-3)] to-[var(--bg-2)] p-7 relative overflow-hidden"
            style={{ boxShadow: "var(--shadow-elevated)" }}
        >
            <div
                aria-hidden
                className="absolute -top-24 -right-24 w-56 h-56 rounded-full bg-[var(--accent)]/12 blur-3xl pointer-events-none"
            />
            <div className="relative">
                <div className="flex items-center gap-3 mb-5">
                    <span className="relative flex h-2.5 w-2.5">
                        <span
                            className="absolute inline-flex h-full w-full rounded-full bg-[var(--accent)]"
                            style={{
                                animation:
                                    "kodus-pulse-ring 1.6s cubic-bezier(0.21,0.6,0.35,1) infinite",
                            }}
                        />
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--accent)]" />
                    </span>
                    <p className="text-[15px] text-[var(--text)] font-medium tracking-tight">
                        {STAGES[stageIdx]}
                        <span className="text-[var(--text-dim)]">…</span>
                    </p>
                    <span className="ml-auto text-xs font-mono text-[var(--text-dim)]">
                        {elapsedSeconds}s
                    </span>
                </div>

                <ol className="space-y-1.5">
                    {STAGES.map((stage, idx) => {
                        const isPast = idx < stageIdx;
                        const isCurrent = idx === stageIdx;
                        return (
                            <li
                                key={stage}
                                className={`flex items-center gap-2.5 text-[13px] transition-colors ${
                                    isPast
                                        ? "text-[var(--green)]"
                                        : isCurrent
                                          ? "text-[var(--text)]"
                                          : "text-[var(--text-dim)]"
                                }`}
                            >
                                <span className="font-mono w-4 text-center">
                                    {isPast ? (
                                        <CheckMini />
                                    ) : isCurrent ? (
                                        "→"
                                    ) : (
                                        "·"
                                    )}
                                </span>
                                {stage}
                            </li>
                        );
                    })}
                </ol>

                <p className="text-xs text-[var(--text-dim)] mt-5 pt-4 border-t border-[var(--border)]">
                    Most reviews finish in 30–90 seconds.
                </p>
            </div>
        </div>
    );
}

function CheckMini() {
    return (
        <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="inline-block"
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}
