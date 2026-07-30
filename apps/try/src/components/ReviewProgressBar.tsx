"use client";

import { useEffect, useMemo, useState } from "react";
import type { PrInfo } from "@/lib/api";

const KODY_AVATAR_URL = "https://avatars.githubusercontent.com/in/413034?v=4";

// Median run is ~3min on Gemini 3 Flash + sandbox. We tell the user
// 4 min so the ETA doesn't flip from "30s remaining" to "still working"
// — under-promise, over-deliver.
const ETA_SECONDS = 240;

type Phase = {
    id: string;
    /** When this phase becomes the current one, in seconds since start. */
    at: number;
    /** Lines we cycle through while in this phase. */
    lines: (file: string | null) => string[];
};

const PHASES: Phase[] = [
    {
        id: "fetch",
        at: 0,
        lines: () => [
            "Pulling the PR from GitHub…",
            "Fetching diff…",
            "Reading the patch…",
        ],
    },
    {
        id: "clone",
        at: 10,
        lines: () => [
            "Spinning up a sandbox to explore the repo…",
            "Cloning the repo into an isolated sandbox…",
            "Checking out the PR head…",
        ],
    },
    {
        id: "explore",
        at: 35,
        lines: (file) => [
            file
                ? `Opening \`${file}\`…`
                : "Opening the changed files…",
            "Tracing call sites for the changed functions…",
            file
                ? `Looking for usages of symbols in \`${file}\`…`
                : "Looking for usages of changed symbols…",
            "Cross-referencing imports…",
        ],
    },
    {
        id: "analyze",
        at: 80,
        lines: (file) => [
            "Hunting for bugs…",
            file
                ? `Re-reading \`${file}\` for edge cases…`
                : "Reasoning about edge cases…",
            "Checking error handling paths…",
            "Validating types and null-safety…",
            "Looking for race conditions…",
        ],
    },
    {
        id: "write",
        at: 170,
        lines: () => [
            "Drafting suggestions…",
            "Trimming nitpicks — keeping only what matters…",
            "Ranking findings by severity…",
            "Almost done — finalizing the review…",
        ],
    },
];

export function ReviewProgressBar({
    elapsedSeconds,
    pr,
    files,
}: {
    elapsedSeconds: number;
    pr?: PrInfo;
    files?: string[];
}) {
    const phase = useMemo(() => {
        let current = PHASES[0];
        for (const p of PHASES) {
            if (elapsedSeconds >= p.at) current = p;
        }
        return current;
    }, [elapsedSeconds]);

    // Rotate the message every ~4.5s within the current phase. Tied to
    // `elapsedSeconds` so the line is deterministic per second and
    // doesn't reshuffle on re-renders (avoids visible flicker).
    const [activeFile, setActiveFile] = useState<string | null>(null);
    useEffect(() => {
        if (!files?.length) return;
        // Pick a file roughly per phase so the user sees the agent "moving
        // through the PR" instead of staring at the same path.
        const idx = Math.min(
            files.length - 1,
            Math.floor(elapsedSeconds / 22),
        );
        setActiveFile(files[idx] ?? null);
    }, [elapsedSeconds, files]);

    const message = useMemo(() => {
        const lines = phase.lines(activeFile);
        const slot = Math.floor(elapsedSeconds / 4.5);
        return lines[slot % lines.length];
    }, [phase, elapsedSeconds, activeFile]);

    const remaining = Math.max(15, ETA_SECONDS - elapsedSeconds);
    const remainingLabel = humanRemaining(remaining);

    // Real-time progress — caps at 92% so we don't promise "done" before
    // the worker actually says COMPLETED.
    const pct = Math.min(92, (elapsedSeconds / ETA_SECONDS) * 100);

    const phaseIdx = PHASES.findIndex((p) => p.id === phase.id);

    return (
        <div
            className="sticky top-16 z-20 border-b border-[var(--border)]/60 bg-[var(--bg-2)]/95 backdrop-blur-md hairline-bottom"
            role="status"
            aria-live="polite"
        >
            <div className="max-w-[1600px] mx-auto px-6 py-2.5 flex items-center gap-3">
                <KodyAvatar />

                <div className="min-w-0 flex-1">
                    <p
                        key={message}
                        className="text-[13px] text-[var(--text)] truncate fade-up"
                        style={{ animationDuration: "0.35s" }}
                    >
                        <span className="text-[var(--text-muted)]">Kody:</span>{" "}
                        <span className="font-medium">{message}</span>
                    </p>
                    {pr && (
                        <p className="text-[11px] font-mono text-[var(--text-dim)] truncate">
                            {pr.owner}/{pr.repo} #{pr.prNumber}
                            <span className="mx-1.5">·</span>
                            <span className="text-[var(--green)]">
                                +{pr.additions}
                            </span>{" "}
                            <span className="text-[var(--red)]">
                                −{pr.deletions}
                            </span>{" "}
                            <span className="text-[var(--text-dim)]">
                                · {pr.changedFiles} files
                            </span>
                        </p>
                    )}
                </div>

                <ol className="hidden lg:flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--text-dim)] shrink-0">
                    {PHASES.map((p, idx) => {
                        const past = idx < phaseIdx;
                        const current = idx === phaseIdx;
                        return (
                            <li
                                key={p.id}
                                className={`flex items-center gap-1 transition-colors ${
                                    past
                                        ? "text-[var(--green)]"
                                        : current
                                          ? "text-[var(--text)]"
                                          : ""
                                }`}
                            >
                                <span
                                    className={`w-1 h-1 rounded-full ${
                                        past
                                            ? "bg-[var(--green)]"
                                            : current
                                              ? "bg-[var(--accent)] animate-pulse"
                                              : "bg-[var(--text-dim)]"
                                    }`}
                                />
                                {p.id}
                            </li>
                        );
                    })}
                </ol>

                <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0 tabular-nums">
                    {remainingLabel}
                </span>
            </div>

            {/* Progress strip — width is the elapsed-vs-ETA percentage,
                overlaid with a slow horizontal shimmer so it reads as
                "alive" even while pct doesn't change. */}
            <div className="h-[3px] bg-[var(--bg-3)] overflow-hidden relative">
                <div
                    className="absolute inset-y-0 left-0 bg-[var(--accent)] transition-[width] duration-700 ease-out"
                    style={{
                        width: `${pct}%`,
                        boxShadow: "0 0 12px var(--accent-glow)",
                    }}
                />
                <div
                    className="absolute inset-y-0 left-0 w-[120px] -translate-x-full"
                    style={{
                        background:
                            "linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent)",
                        animation: "kodus-shimmer 1.8s linear infinite",
                    }}
                />
            </div>
        </div>
    );
}

function KodyAvatar() {
    return (
        <div className="relative shrink-0">
            <span
                aria-hidden
                className="absolute inset-0 rounded-full bg-[var(--accent)]/40 blur-sm"
                style={{
                    animation:
                        "kodus-pulse-ring 1.8s cubic-bezier(0.21,0.6,0.35,1) infinite",
                }}
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                src={KODY_AVATAR_URL}
                alt=""
                width={26}
                height={26}
                className="relative rounded-full ring-2 ring-[var(--bg-2)]"
            />
        </div>
    );
}

function humanRemaining(seconds: number): string {
    if (seconds <= 20) return "about 20s left";
    if (seconds <= 45) return "about 30s left";
    if (seconds < 90) return "about 1 min left";
    if (seconds < 150) return "about 2 min left";
    if (seconds < 210) return "about 3 min left";
    return "about 4 min left";
}
