"use client";

import { useMemo, useState } from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    ModelPricingInfo,
    UsageByTaskAreaResultContract,
    UsageByTaskModelSpanContract,
} from "@services/usage/types";
import { formatUsd } from "@services/usage/format";
import { ChevronRightIcon } from "lucide-react";

import { CHART_COLORS } from "../../cockpit/_components/charts/recharts-shared";
import { rowCost } from "../_utils/cost";

/** Task labels + descriptions (the `LlmTask` set in libs/llm/byok-config.ts).
 *  A task is WHICH model the org picked — the config axis. `''` = unattributable. */
const TASK_META: Record<string, { label: string; description: string }> = {
    codeReview: {
        label: "Code Review",
        description:
            "The defect-finding review agents plus suggestion refinement and cross-file context — the model you set for Code Review.",
    },
    kodyRulesReview: {
        label: "Kody Rules Review",
        description:
            "Enforcing your Kody Rules on the diff — the model set for Kody Rules Review (inherits Code Review's when unset).",
    },
    prSummary: {
        label: "PR Summary",
        description: "Writing the PR summary comment — the model set for PR Summary.",
    },
    businessValidation: {
        label: "Business Validation",
        description:
            "The business-rules validation agent — the model set for Business Validation.",
    },
    ruleGeneration: {
        label: "Rule Generation",
        description: "Generating and learning Kody Rules from PR history and feedback.",
    },
    conversation: {
        label: "Conversation",
        description: "Answering your @kody replies in review threads.",
    },
    "": {
        label: "Unrouted",
        description:
            "Spend not attributable to a routing task — internal/system steps, or older runs recorded before per-task routing.",
    },
};

/** Process-area labels (the drill-down under each task). */
const AREA_LABEL: Record<string, string> = {
    review: "Review agents",
    suggestions: "Suggestion refinement",
    kody_rules: "Kody Rules",
    summary: "PR summary",
    conversation: "Conversation",
    system: "System analysis",
    other: "Other",
};

// Token-type segments — SAME keys, colors and order as the daily chart.
const SEGMENTS = [
    { key: "input", label: "Input", color: CHART_COLORS.info },
    { key: "cache", label: "Cache", color: CHART_COLORS.purple },
    { key: "output", label: "Output", color: CHART_COLORS.success },
    { key: "reasoning", label: "Reasoning", color: CHART_COLORS.warning },
] as const;

// Models-used tracks use ONE neutral tone on purpose. The colored palette is the
// token-TYPE legend (Input/Cache/Output/Reasoning); tinting model rows with those
// same hues makes a model bar read as a token type. Models are told apart by their
// row label + time window — the track only encodes WHEN, so it stays neutral.
const MODEL_TRACK = CHART_COLORS.muted;

type Comp = { input: number; cache: number; output: number; reasoning: number };
const zeroComp = (): Comp => ({ input: 0, cache: 0, output: 0, reasoning: 0 });

const addComp = (c: Comp, row: UsageByTaskAreaResultContract) => {
    const cache = row.cacheRead ?? 0;
    const reasoning = row.outputReasoning ?? 0;
    c.input += Math.max(0, row.input - cache);
    c.cache += cache;
    c.output += Math.max(0, row.output - reasoning);
    c.reasoning += reasoning;
};

const formatTokens = (t: number) => {
    if (t === 0) return "0";
    if (t < 1000) return t.toString();
    if (t < 1000000) return `${(t / 1000).toFixed(1)}K`;
    return `${(t / 1000000).toFixed(1)}M`;
};

const shortModel = (model: string) =>
    (model.split(":").pop() ?? model).split("/").pop() ?? model;

const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const fmtDay = (ms: number) => {
    const d = new Date(ms);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
/** "Aug 7 – 13" (same month), "Aug 30 – Sep 2", or "Aug 7" (single day). */
const fmtRange = (a: number, b: number) => {
    const da = new Date(a);
    const db = new Date(b);
    if (da.getUTCFullYear() === db.getUTCFullYear() &&
        da.getUTCMonth() === db.getUTCMonth() &&
        da.getUTCDate() === db.getUTCDate()) {
        return fmtDay(a);
    }
    if (da.getUTCFullYear() === db.getUTCFullYear() &&
        da.getUTCMonth() === db.getUTCMonth()) {
        return `${MONTHS[da.getUTCMonth()]} ${da.getUTCDate()} – ${db.getUTCDate()}`;
    }
    return `${fmtDay(a)} – ${fmtDay(b)}`;
};

type AreaRow = { area: string; label: string; tokens: number };
type ModelRow = {
    model: string;
    tokens: number;
    cost: number;
    priced: boolean;
    firstMs?: number;
    lastMs?: number;
};
type TaskRow = {
    task: string;
    label: string;
    description: string;
    tokens: number;
    cost: number;
    priced: boolean;
    comp: Comp;
    models: ModelRow[];
    areas: AreaRow[];
};

// The stacked, token-typed share bar (used for a whole task).
const TokenBar = ({ comp, grandTotal }: { comp: Comp; grandTotal: number }) => (
    <Tooltip>
        <TooltipTrigger asChild>
            <div className="bg-card-lv2 flex h-2.5 min-w-0 flex-1 cursor-help overflow-hidden rounded-full">
                {SEGMENTS.map((s) => {
                    const v = comp[s.key];
                    if (v <= 0 || grandTotal <= 0) return null;
                    return (
                        <span
                            key={s.key}
                            className="h-full"
                            style={{
                                width: `${(v / grandTotal) * 100}%`,
                                backgroundColor: s.color,
                            }}
                        />
                    );
                })}
            </div>
        </TooltipTrigger>
        <TooltipContent className="text-text-primary">
            <div className="flex flex-col gap-0.5 text-xs">
                {SEGMENTS.map((s) => (
                    <span key={s.key} className="flex items-center justify-between gap-4">
                        <span className="flex items-center gap-1.5">
                            <span
                                className="size-2 rounded-xs"
                                style={{ backgroundColor: s.color }}
                            />
                            {s.label}
                        </span>
                        <span className="font-mono">{formatTokens(comp[s.key])}</span>
                    </span>
                ))}
            </div>
        </TooltipContent>
    </Tooltip>
);

/**
 * "Where tokens go" — spend per routing TASK (the model picked per task). A task
 * keeps its meaning even when the model behind it changes over the period, so
 * the row never claims a single model: expanding reveals the MODELS that served
 * it (with share + cost) and the process STEPS it fanned out over.
 */
export const TaskBreakdown = ({
    rows,
    modelSpans = [],
    selectedModels,
    pricing,
}: {
    rows: UsageByTaskAreaResultContract[];
    /** First/last timestamp per task × model — the "when" for Models used. */
    modelSpans?: UsageByTaskModelSpanContract[];
    selectedModels: string[];
    pricing: Record<string, ModelPricingInfo>;
}) => {
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const tasks = useMemo<TaskRow[]>(() => {
        const selected = new Set(selectedModels);
        // task|model → active window (ms). Parsed once; attached per model row.
        const spanOf = new Map<string, { firstMs: number; lastMs: number }>();
        for (const s of modelSpans) {
            const firstMs = Date.parse(s.firstAt);
            const lastMs = Date.parse(s.lastAt);
            if (!Number.isNaN(firstMs) && !Number.isNaN(lastMs)) {
                spanOf.set(`${s.task}|${s.model}`, { firstMs, lastMs });
            }
        }
        const acc = new Map<
            string,
            {
                tokens: number;
                cost: number;
                priced: boolean;
                comp: Comp;
                models: Map<string, { tokens: number; cost: number; priced: boolean }>;
                areas: Map<string, number>;
            }
        >();
        for (const row of rows) {
            if (!selected.has(row.model)) continue;
            const task = row.task in TASK_META ? row.task : "";
            // Skip unattributable spend (internal/system steps, not a task the
            // org picked a model for). It still counts in the per-model total
            // below; the per-TASK view only lists real routing tasks.
            if (task === "") continue;
            const info = pricing[row.model];
            const cost = rowCost(row, info).total;
            const priced = !!info?.pricing;
            const e =
                acc.get(task) ??
                {
                    tokens: 0,
                    cost: 0,
                    priced: false,
                    comp: zeroComp(),
                    models: new Map<
                        string,
                        { tokens: number; cost: number; priced: boolean }
                    >(),
                    areas: new Map<string, number>(),
                };
            addComp(e.comp, row);
            e.tokens += row.total;
            e.cost += cost;
            e.priced = e.priced || priced;
            const m = e.models.get(row.model) ?? { tokens: 0, cost: 0, priced: false };
            m.tokens += row.total;
            m.cost += cost;
            m.priced = m.priced || priced;
            e.models.set(row.model, m);
            e.areas.set(row.area, (e.areas.get(row.area) ?? 0) + row.total);
            acc.set(task, e);
        }
        return Array.from(acc.entries())
            .map(([task, e]) => {
                const meta = TASK_META[task] ?? TASK_META[""];
                const models = Array.from(e.models.entries())
                    .map(([model, v]) => ({
                        model,
                        ...v,
                        ...spanOf.get(`${task}|${model}`),
                    }))
                    .sort((a, b) => b.tokens - a.tokens);
                const areas = Array.from(e.areas.entries())
                    .map(([area, tokens]) => ({
                        area,
                        label: AREA_LABEL[area] ?? area,
                        tokens,
                    }))
                    .sort((a, b) => b.tokens - a.tokens);
                return {
                    task,
                    label: meta.label,
                    description: meta.description,
                    tokens: e.tokens,
                    cost: e.cost,
                    priced: e.priced,
                    comp: e.comp,
                    models,
                    areas,
                };
            })
            .sort((a, b) => b.tokens - a.tokens);
    }, [rows, modelSpans, selectedModels, pricing]);

    const grandTotal = tasks.reduce((s, t) => s + t.tokens, 0);

    if (!tasks.length) return null;

    const toggle = (task: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            next.has(task) ? next.delete(task) : next.add(task);
            return next;
        });

    return (
        <Card color="lv1">
            <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                        <CardTitle className="text-sm">Where tokens go</CardTitle>
                        <CardDescription className="text-xs">
                            Spend by routing task. A task keeps its meaning even when
                            you switch the model behind it — expand to see which models
                            ran it and the steps involved.
                        </CardDescription>
                    </div>
                    <div className="flex items-center gap-3">
                        {SEGMENTS.map((s) => (
                            <span
                                key={s.key}
                                className="text-text-tertiary flex items-center gap-1.5 text-[11px]">
                                <span
                                    className="size-2 rounded-xs"
                                    style={{ backgroundColor: s.color }}
                                />
                                {s.label}
                            </span>
                        ))}
                    </div>
                </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
                {tasks.map((t) => {
                    const isOpen = expanded.has(t.task);
                    const multiModel = t.models.length > 1;
                    const hasDetail = multiModel || t.areas.length > 1;
                    return (
                        <div key={t.task || "__unrouted__"} className="flex flex-col">
                            {/* task row */}
                            <button
                                type="button"
                                onClick={() => hasDetail && toggle(t.task)}
                                className={`flex items-center gap-3 rounded-md py-1 text-left ${
                                    hasDetail
                                        ? "hover:bg-card-lv2/50 cursor-pointer"
                                        : "cursor-default"
                                }`}>
                                <ChevronRightIcon
                                    className={`text-text-tertiary size-3.5 shrink-0 transition-transform ${
                                        isOpen ? "rotate-90" : ""
                                    } ${hasDetail ? "" : "opacity-0"}`}
                                />
                                <div className="flex w-52 shrink-0 flex-col">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <span className="text-text-primary cursor-help truncate text-xs font-medium underline decoration-dotted decoration-from-font underline-offset-4">
                                                {t.label}
                                            </span>
                                        </TooltipTrigger>
                                        <TooltipContent className="text-text-primary max-w-64 text-pretty">
                                            {t.description}
                                        </TooltipContent>
                                    </Tooltip>
                                    {multiModel ? (
                                        <span className="text-text-tertiary flex items-center gap-1.5 text-[11px]">
                                            <span className="flex">
                                                {t.models.slice(0, 3).map((m) => (
                                                    <span
                                                        key={m.model}
                                                        className="border-card-lv1 -mr-0.5 size-1.5 rounded-full border"
                                                        style={{
                                                            backgroundColor: MODEL_TRACK,
                                                        }}
                                                    />
                                                ))}
                                            </span>
                                            {t.models.length} models this period
                                        </span>
                                    ) : (
                                        <span className="text-text-tertiary truncate font-mono text-[11px]">
                                            {t.models[0]
                                                ? shortModel(t.models[0].model)
                                                : "—"}
                                            {t.models[0]?.firstMs != null &&
                                                t.models[0]?.lastMs != null && (
                                                    <span className="opacity-70">
                                                        {" · "}
                                                        {fmtRange(
                                                            t.models[0].firstMs,
                                                            t.models[0].lastMs,
                                                        )}
                                                    </span>
                                                )}
                                        </span>
                                    )}
                                </div>
                                <TokenBar comp={t.comp} grandTotal={grandTotal} />
                                <span className="text-text-primary w-16 shrink-0 text-right font-mono text-xs font-semibold tabular-nums">
                                    {formatTokens(t.tokens)}
                                </span>
                                <span className="text-text-secondary w-16 shrink-0 text-right font-mono text-xs tabular-nums">
                                    {t.priced ? formatUsd(t.cost) : "—"}
                                </span>
                            </button>

                            {/* drill-down: models + steps */}
                            {isOpen && (
                                <div className="border-card-lv2 mb-1 ml-[26px] flex flex-col gap-3 border-l pt-1 pl-3">
                                    {multiModel && (() => {
                                        // Task window bounds from the models that
                                        // carry one → position each model's track
                                        // so a mid-period switch reads as a handoff.
                                        const wins = t.models.filter(
                                            (m) => m.firstMs != null && m.lastMs != null,
                                        );
                                        const tMin = wins.length
                                            ? Math.min(...wins.map((m) => m.firstMs!))
                                            : 0;
                                        const tMax = wins.length
                                            ? Math.max(...wins.map((m) => m.lastMs!))
                                            : 0;
                                        const range = Math.max(1, tMax - tMin);
                                        return (
                                        <div className="flex flex-col gap-1.5">
                                            <span className="text-text-tertiary text-[10px] font-semibold tracking-wide uppercase">
                                                Models used
                                            </span>
                                            {t.models.map((m) => {
                                                const hasWin =
                                                    m.firstMs != null && m.lastMs != null;
                                                const left = hasWin
                                                    ? ((m.firstMs! - tMin) / range) * 100
                                                    : 0;
                                                const width = hasWin
                                                    ? Math.max(
                                                          4,
                                                          ((m.lastMs! - m.firstMs!) / range) * 100,
                                                      )
                                                    : t.tokens > 0
                                                      ? (m.tokens / t.tokens) * 100
                                                      : 0;
                                                const pct =
                                                    t.tokens > 0
                                                        ? Math.round((m.tokens / t.tokens) * 100)
                                                        : 0;
                                                return (
                                                <Tooltip key={m.model}>
                                                    <TooltipTrigger asChild>
                                                        <div className="flex cursor-help items-center gap-3">
                                                    <span className="text-text-secondary w-40 shrink-0 truncate font-mono text-[11px]">
                                                        {shortModel(m.model)}
                                                    </span>
                                                    <div className="bg-card-lv2 relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
                                                        <div
                                                            className="absolute h-full rounded-full"
                                                            style={{
                                                                left: `${left}%`,
                                                                width: `${width}%`,
                                                                backgroundColor: MODEL_TRACK,
                                                            }}
                                                        />
                                                    </div>
                                                    <span className="text-text-tertiary w-24 shrink-0 text-right text-[11px] tabular-nums">
                                                        {hasWin
                                                            ? fmtRange(m.firstMs!, m.lastMs!)
                                                            : "—"}
                                                    </span>
                                                    <span className="text-text-tertiary w-14 shrink-0 text-right font-mono text-[11px] tabular-nums">
                                                        {formatTokens(m.tokens)}
                                                    </span>
                                                    <span className="text-text-secondary w-14 shrink-0 text-right font-mono text-[11px] tabular-nums">
                                                        {m.priced ? formatUsd(m.cost) : "—"}
                                                    </span>
                                                        </div>
                                                    </TooltipTrigger>
                                                    <TooltipContent className="text-text-primary">
                                                        <div className="flex flex-col gap-0.5 text-xs">
                                                            <span className="font-mono">
                                                                {shortModel(m.model)}
                                                            </span>
                                                            <span className="text-text-secondary">
                                                                {hasWin
                                                                    ? `Active ${fmtRange(m.firstMs!, m.lastMs!)}`
                                                                    : "Active window unavailable"}
                                                            </span>
                                                            <span className="text-text-secondary">
                                                                {formatTokens(m.tokens)} tokens · {pct}% of {t.label}
                                                            </span>
                                                            <span className="text-text-secondary">
                                                                {m.priced ? formatUsd(m.cost) : "No price in catalog"}
                                                            </span>
                                                        </div>
                                                    </TooltipContent>
                                                </Tooltip>
                                                );
                                            })}
                                        </div>
                                        );
                                    })()}

                                    {t.areas.length > 1 && (
                                        <div className="flex flex-col gap-1.5">
                                            <span className="text-text-tertiary text-[10px] font-semibold tracking-wide uppercase">
                                                Steps
                                            </span>
                                            {t.areas.map((a) => {
                                                const pct =
                                                    t.tokens > 0
                                                        ? Math.round((a.tokens / t.tokens) * 100)
                                                        : 0;
                                                return (
                                                <Tooltip key={a.area}>
                                                    <TooltipTrigger asChild>
                                                        <div className="flex cursor-help items-center gap-3">
                                                    <span className="text-text-tertiary w-48 shrink-0 truncate text-[11px]">
                                                        {a.label}
                                                    </span>
                                                    <div className="bg-card-lv2 h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
                                                        <div
                                                            className="bg-text-tertiary/50 h-full rounded-full"
                                                            style={{
                                                                width: `${
                                                                    t.tokens > 0
                                                                        ? (a.tokens / t.tokens) * 100
                                                                        : 0
                                                                }%`,
                                                            }}
                                                        />
                                                    </div>
                                                    <span className="text-text-tertiary w-16 shrink-0 text-right font-mono text-[11px] tabular-nums">
                                                        {formatTokens(a.tokens)}
                                                    </span>
                                                    <span className="w-16 shrink-0" />
                                                        </div>
                                                    </TooltipTrigger>
                                                    <TooltipContent className="text-text-primary">
                                                        <div className="flex flex-col gap-0.5 text-xs">
                                                            <span>{a.label}</span>
                                                            <span className="text-text-secondary">
                                                                {formatTokens(a.tokens)} tokens · {pct}% of {t.label}
                                                            </span>
                                                        </div>
                                                    </TooltipContent>
                                                </Tooltip>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </CardContent>
        </Card>
    );
};
