"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
    baseVersionLabel,
    comparisonSideLabel,
} from "@services/runtime/model/base-version";
import type { Tone } from "@services/runtime/labels";
import {
    buildBrowserEvidence,
    initialPair,
    stepAt,
    type BrowserEvidenceView,
    type BrowserStepChip,
    type StepOutcome,
} from "@services/runtime/model/browser-evidence";
import type { ReplayLanes } from "@services/runtime/model/replay-lanes";
import { cn } from "src/core/utils/components";

import { EvidenceLink } from "./evidence-link";
import { EvidenceImage, EvidenceVideo } from "./evidence-media";
import { TONE_DOT_CLASS } from "./status-chip";

// A browser finding (ADR-071): the steps main and this PR played as chips,
// the same step's screenshots side by side (or under a slider, or as the
// pixel diff), the two recordings on the steps' timeline, and the page's
// console and network. Images and video come only from signed URLs on the
// isolated evidence origin (evidence-media.tsx).

const OUTCOME_TONE: Record<StepOutcome, Tone> = {
    passed: "success",
    failed: "danger",
    skipped: "neutral",
    absent: "neutral",
};

const OUTCOME_WORD: Record<StepOutcome, string> = {
    passed: "passed",
    failed: "failed",
    skipped: "skipped",
    absent: "not run",
};

type Mode = "side" | "slider" | "diff";

const StepChip = ({
    chip,
    selected,
    current,
    onSelect,
    baseLabel,
}: {
    chip: BrowserStepChip;
    selected: boolean;
    current: boolean;
    onSelect: () => void;
    baseLabel: string;
}) => (
    <li>
        <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            aria-label={`Step ${chip.index + 1}: ${chip.label}. ${baseLabel} ${OUTCOME_WORD[chip.base]}, this PR ${OUTCOME_WORD[chip.pr]}${chip.first ? ". First difference" : ""}`}
            className={cn(
                "bg-card-lv2 flex max-w-72 items-center gap-2 rounded-full px-3 py-1 text-left font-mono text-xs",
                chip.differs && "ring-danger/50 ring-1",
                selected && "ring-primary-light ring-2",
                current && "bg-card-lv3",
            )}>
            <span className="flex items-center gap-1" aria-hidden>
                <span
                    className={cn(
                        "size-2 rounded-full",
                        TONE_DOT_CLASS[OUTCOME_TONE[chip.base]],
                    )}
                />
                <span
                    className={cn(
                        "size-2 rounded-full",
                        TONE_DOT_CLASS[OUTCOME_TONE[chip.pr]],
                    )}
                />
            </span>
            <span className="text-text-tertiary">{chip.index + 1}</span>
            <span className="text-text-primary truncate">{chip.label}</span>
            {chip.first && (
                <span className="text-danger shrink-0">first difference</span>
            )}
        </button>
    </li>
);

const StepDetail = ({
    chip,
    baseLabel,
}: {
    chip: BrowserStepChip;
    baseLabel: string;
}) => (
    <div className="flex flex-col gap-1 text-xs">
        <span className="text-text-secondary">
            Step {chip.index + 1}: {baseLabel} {OUTCOME_WORD[chip.base]}, this
            PR {OUTCOME_WORD[chip.pr]}
            {chip.why ? ` (${chip.why})` : ""}
        </span>
        {chip.values && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono">
                <dt className="text-text-tertiary">{baseLabel} read</dt>
                <dd className="text-text-primary break-all whitespace-pre-wrap">
                    {chip.values.base === undefined
                        ? "—"
                        : chip.values.base || "(empty)"}
                </dd>
                <dt className="text-text-tertiary">this PR read</dt>
                <dd className="text-danger break-all whitespace-pre-wrap">
                    {chip.values.pr === undefined
                        ? "—"
                        : chip.values.pr || "(empty)"}
                </dd>
            </dl>
        )}
    </div>
);

const Screens = ({
    runId,
    view,
    pairIndex,
    setPairIndex,
    baseLabel,
}: {
    runId: string;
    view: BrowserEvidenceView;
    pairIndex: number;
    setPairIndex: (i: number) => void;
    baseLabel: string;
}) => {
    const [mode, setMode] = useState<Mode>("side");
    const [split, setSplit] = useState(50);
    const pair = view.pairs[pairIndex];
    if (!pair)
        return (
            <p className="text-text-tertiary text-xs">
                No screenshot was taken in this probe.
            </p>
        );
    const base = {
        runId,
        stepId: view.video.base.stepId,
        side: "base" as const,
    };
    const pr = { runId, stepId: view.video.pr.stepId, side: "pr" as const };
    const modes: Array<{ id: Mode; label: string; disabled?: boolean }> = [
        { id: "side", label: "Side by side" },
        { id: "slider", label: "Slider", disabled: !pair.base || !pair.pr },
        { id: "diff", label: "Pixel diff", disabled: !pair.pixeldiff },
    ];
    return (
        <section aria-label="Screenshots" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
                {view.pairs.length > 1 && (
                    <select
                        aria-label="Screenshot"
                        value={pairIndex}
                        onChange={(e) => setPairIndex(Number(e.target.value))}
                        className="bg-card-lv2 text-text-primary rounded-md px-2 py-1 font-mono text-xs">
                        {view.pairs.map((p, i) => (
                            <option key={p.step} value={i}>
                                Step {p.step + 1}: {p.label}
                            </option>
                        ))}
                    </select>
                )}
                <div
                    role="group"
                    aria-label="Compare"
                    className="bg-card-lv2 flex rounded-md p-0.5">
                    {modes.map((m) => (
                        <button
                            key={m.id}
                            type="button"
                            disabled={m.disabled}
                            aria-pressed={mode === m.id}
                            onClick={() => setMode(m.id)}
                            className={cn(
                                "rounded px-2 py-1 text-xs disabled:opacity-40",
                                mode === m.id
                                    ? "bg-card-lv3 text-text-primary"
                                    : "text-text-secondary",
                            )}>
                            {m.label}
                        </button>
                    ))}
                </div>
                {pair.changed && (
                    <span
                        className={cn(
                            "text-xs",
                            (pair.ratio ?? 0) > 0.001
                                ? "text-danger"
                                : "text-text-secondary",
                        )}>
                        {pair.changed}
                    </span>
                )}
            </div>
            {mode === "side" && (
                <div className="grid gap-3 md:grid-cols-2">
                    {(["base", "pr"] as const).map((side) => (
                        <figure
                            key={side}
                            className="flex min-w-0 flex-col gap-1">
                            <figcaption className="text-text-tertiary text-xs">
                                {comparisonSideLabel(side, baseLabel)}
                            </figcaption>
                            <EvidenceImage
                                {...(side === "base" ? base : pr)}
                                type={pair[side]}
                                alt={`${comparisonSideLabel(side, baseLabel)} at step ${pair.step + 1}: ${pair.label}`}
                            />
                        </figure>
                    ))}
                </div>
            )}
            {mode === "slider" && (
                <figure className="flex flex-col gap-2">
                    <div className="relative overflow-hidden rounded-md">
                        <EvidenceImage
                            {...base}
                            type={pair.base}
                            alt={`${baseLabel} at step ${pair.step + 1}`}
                        />
                        {/* this PR over main, cut at the slider: left of it is this PR. */}
                        <div
                            className="absolute inset-0"
                            style={{
                                clipPath: `inset(0 ${100 - split}% 0 0)`,
                            }}>
                            <EvidenceImage
                                {...pr}
                                type={pair.pr}
                                alt={`this PR at step ${pair.step + 1}`}
                            />
                        </div>
                        <div
                            aria-hidden
                            className="bg-primary-light absolute inset-y-0 w-0.5"
                            style={{ left: `${split}%` }}
                        />
                    </div>
                    <label className="text-text-tertiary flex items-center gap-2 text-xs">
                        <span>this PR</span>
                        <input
                            type="range"
                            min={0}
                            max={100}
                            value={split}
                            onChange={(e) => setSplit(Number(e.target.value))}
                            aria-label={`Slide between this PR and ${baseLabel}`}
                            className="flex-1"
                        />
                        <span>{baseLabel}</span>
                    </label>
                </figure>
            )}
            {mode === "diff" && (
                <figure className="flex flex-col gap-1">
                    <figcaption className="text-text-tertiary text-xs">
                        Pixels that changed from {baseLabel}, in red
                    </figcaption>
                    <EvidenceImage
                        {...pr}
                        type={pair.pixeldiff}
                        alt={`Pixel diff at step ${pair.step + 1}: ${pair.changed ?? ""}`}
                    />
                </figure>
            )}
        </section>
    );
};

const Videos = ({
    runId,
    view,
    onStep,
    current,
    baseLabel,
}: {
    runId: string;
    view: BrowserEvidenceView;
    onStep: (i: number) => void;
    current: number;
    baseLabel: string;
}) => {
    const base = useRef<HTMLVideoElement>(null);
    const pr = useRef<HTMLVideoElement>(null);
    const seekTo = useCallback(
        (index: number) => {
            for (const [ref, side] of [
                [base, view.video.base],
                [pr, view.video.pr],
            ] as const) {
                const mark = side.marks.find((m) => m.index === index);
                if (ref.current && mark) ref.current.currentTime = mark.at;
            }
            onStep(index);
        },
        [view, onStep],
    );
    const both = (play: boolean) => {
        for (const v of [base.current, pr.current]) {
            if (!v) continue;
            if (play) void v.play().catch(() => undefined);
            else v.pause();
        }
    };
    if (!view.video.base.available && !view.video.pr.available) return null;
    return (
        <section aria-label="Recordings" className="flex flex-col gap-2">
            <div className="grid gap-3 md:grid-cols-2">
                {(["base", "pr"] as const).map((side) => (
                    <figure key={side} className="flex min-w-0 flex-col gap-1">
                        <figcaption className="text-text-tertiary text-xs">
                            {comparisonSideLabel(side, baseLabel)}
                        </figcaption>
                        <EvidenceVideo
                            ref={side === "base" ? base : pr}
                            runId={runId}
                            stepId={view.video[side].stepId}
                            side={side}
                            label={`Recording of ${comparisonSideLabel(side, baseLabel)}`}
                            available={view.video[side].available}
                            onTimeUpdate={
                                side === "pr"
                                    ? (e) =>
                                          onStep(
                                              stepAt(
                                                  view.video.pr.marks,
                                                  e.currentTarget.currentTime,
                                              ),
                                          )
                                    : undefined
                            }
                        />
                    </figure>
                ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={() => both(true)}
                    className="bg-card-lv2 text-text-primary rounded-md px-2 py-1 text-xs">
                    Play both
                </button>
                <button
                    type="button"
                    onClick={() => both(false)}
                    className="bg-card-lv2 text-text-primary rounded-md px-2 py-1 text-xs">
                    Pause
                </button>
                <ol aria-label="Step timeline" className="flex flex-wrap gap-1">
                    {view.chips.map((c) => (
                        <li key={c.index}>
                            <button
                                type="button"
                                onClick={() => seekTo(c.index)}
                                aria-current={
                                    current === c.index ? "step" : undefined
                                }
                                aria-label={`Go to step ${c.index + 1} in both recordings`}
                                className={cn(
                                    "rounded px-1.5 py-0.5 font-mono text-xs",
                                    current === c.index
                                        ? "bg-primary-light/20 text-text-primary"
                                        : "text-text-secondary",
                                    c.differs && "text-danger",
                                )}>
                                {c.index + 1}
                            </button>
                        </li>
                    ))}
                </ol>
            </div>
        </section>
    );
};

const PageLog = ({
    view,
    baseLabel,
}: {
    view: BrowserEvidenceView;
    baseLabel: string;
}) => {
    const [tab, setTab] = useState<"console" | "network">("console");
    const tabs = [
        { id: "console" as const, label: "Console" },
        { id: "network" as const, label: "Network" },
    ];
    return (
        <section aria-label="Page log" className="flex flex-col gap-2">
            <div role="tablist" aria-label="Page log" className="flex gap-1">
                {tabs.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === t.id}
                        onClick={() => setTab(t.id)}
                        className={cn(
                            "rounded px-2 py-1 text-xs",
                            tab === t.id
                                ? "bg-card-lv3 text-text-primary"
                                : "text-text-secondary",
                        )}>
                        {t.label}
                    </button>
                ))}
            </div>
            <div role="tabpanel" className="grid gap-3 md:grid-cols-2">
                {(["base", "pr"] as const).map((side) => {
                    const rows =
                        tab === "console"
                            ? view.console[side]
                            : view.network[side];
                    return (
                        <div
                            key={side}
                            className="bg-background flex min-w-0 flex-col gap-1 rounded-md p-2">
                            <span className="text-text-tertiary text-xs">
                                {comparisonSideLabel(side, baseLabel)}
                            </span>
                            {rows.length === 0 ? (
                                <span className="text-text-tertiary text-xs">
                                    {tab === "console"
                                        ? "No console message"
                                        : "No request"}
                                </span>
                            ) : (
                                <ul className="flex max-h-48 flex-col gap-0.5 overflow-auto font-mono text-xs">
                                    {tab === "console"
                                        ? view.console[side].map((m, i) => (
                                              <li
                                                  key={i}
                                                  className={cn(
                                                      "break-all",
                                                      m.level === "error"
                                                          ? "text-danger"
                                                          : m.level ===
                                                              "warning"
                                                            ? "text-warning"
                                                            : "text-text-secondary",
                                                  )}>
                                                  {m.level} {m.text}
                                              </li>
                                          ))
                                        : view.network[side].map((n, i) => (
                                              <li
                                                  key={i}
                                                  className={cn(
                                                      "break-all",
                                                      n.status >= 400 ||
                                                          n.status === 0
                                                          ? "text-danger"
                                                          : "text-text-secondary",
                                                  )}>
                                                  {n.method}{" "}
                                                  {n.status || "blocked"}{" "}
                                                  {n.url}
                                                  {n.ms !== undefined
                                                      ? ` · ${n.ms} ms`
                                                      : ""}
                                              </li>
                                          ))}
                                </ul>
                            )}
                        </div>
                    );
                })}
            </div>
            {view.truncated && (
                <span className="text-text-tertiary text-xs">
                    Cut to the first 50 entries; the HAR has every request.
                </span>
            )}
            {tab === "network" && (
                <span className="text-text-tertiary text-xs">
                    WebSockets to the app are allowed and not listed here;
                    their messages are not compared between the two sides.
                </span>
            )}
        </section>
    );
};

const Downloads = ({
    runId,
    view,
    baseLabel,
}: {
    runId: string;
    view: BrowserEvidenceView;
    baseLabel: string;
}) => (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {(["base", "pr"] as const).flatMap((side) => {
            const d = view.downloads[side];
            return [
                d.trace && (
                    <EvidenceLink
                        key={`${side}-trace`}
                        runId={runId}
                        stepId={d.stepId}
                        side={side}
                        type="trace">
                        Playwright trace ({comparisonSideLabel(side, baseLabel)}
                        )
                    </EvidenceLink>
                ),
                d.har && (
                    <EvidenceLink
                        key={`${side}-har`}
                        runId={runId}
                        stepId={d.stepId}
                        side={side}
                        type="har">
                        HAR ({comparisonSideLabel(side, baseLabel)})
                    </EvidenceLink>
                ),
            ];
        })}
    </div>
);

export const BrowserEvidence = ({
    runId,
    lanes,
    baseLabel = baseVersionLabel(),
}: {
    runId: string;
    lanes: ReplayLanes;
    baseLabel?: string;
}) => {
    const view = useMemo(() => buildBrowserEvidence(lanes), [lanes]);
    const [pairIndex, setPairIndex] = useState(() =>
        view ? initialPair(view) : 0,
    );
    const [selected, setSelected] = useState<number | undefined>(
        () => view?.chips.find((c) => c.first)?.index,
    );
    const [current, setCurrent] = useState(0);
    if (!view) return null;
    const select = (i: number) => {
        setSelected(i);
        // The screenshot of that step, or the last one before it.
        const at = view.pairs
            .map((p) => p.step)
            .filter((s) => s <= i)
            .pop();
        const pi =
            at === undefined ? -1 : view.pairs.findIndex((p) => p.step === at);
        if (pi >= 0) setPairIndex(pi);
    };
    const chip = view.chips.find((c) => c.index === selected);
    return (
        <div className="flex flex-col gap-4" aria-label="Browser evidence">
            <section aria-label="Steps" className="flex flex-col gap-2">
                <ol className="flex flex-wrap gap-2">
                    {view.chips.map((c) => (
                        <StepChip
                            key={c.index}
                            chip={c}
                            baseLabel={baseLabel}
                            selected={selected === c.index}
                            current={current === c.index}
                            onSelect={() => select(c.index)}
                        />
                    ))}
                </ol>
                {chip && <StepDetail chip={chip} baseLabel={baseLabel} />}
            </section>
            <Screens
                runId={runId}
                view={view}
                pairIndex={pairIndex}
                setPairIndex={setPairIndex}
                baseLabel={baseLabel}
            />
            <Videos
                runId={runId}
                view={view}
                onStep={setCurrent}
                current={current}
                baseLabel={baseLabel}
            />
            <PageLog view={view} baseLabel={baseLabel} />
            <Downloads runId={runId} view={view} baseLabel={baseLabel} />
        </div>
    );
};
