"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandInput,
    CommandItem,
    CommandList,
} from "@components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    AlertTriangleIcon,
    ChevronsUpDownIcon,
    FileTextIcon,
    GitPullRequestIcon,
    ListChecksIcon,
    MessageSquareIcon,
    ShieldCheckIcon,
    type LucideIcon,
} from "lucide-react";

import { cn } from "src/core/utils/components";

import type { LlmTask } from "../../_types";
import { modelLabelFor, TASK_DESCRIPTIONS } from "../../_utils";
import { ProviderAvatar } from "../provider-avatar";
import { capabilityGate, type SurfacedCapabilities } from "./capability-gate";

/** One selectable model in the connected pool (a BYOKModelConfig projected for
 *  the routing selects). `id` is the BYOKModelConfig.id routing writes. */
export type PoolModel = {
    id: string;
    label: string;
    /** Provider id (from the model's credential) — drives the provider avatar. */
    provider?: string;
    capabilities?: SurfacedCapabilities;
    /** Curated quality/perf signal (joined by model id in routing-tab). This is
     *  where the "which model?" decision actually happens, so the score/speed/
     *  context/cost live HERE — pre-formatted strings so this stays decoupled
     *  from the curated catalog. Absent for non-curated models. */
    score?: number;
    speedLabel?: string;
    contextLabel?: string;
    costLabel?: string;
};

/** The compact perf strip under a model name in the routing picker (speed +
 *  context). The quality score (★) and relative cost ($) were intentionally
 *  removed from the UI — Kodus's proprietary "model intelligence" signal, held
 *  back for a future paid feature (data still joined in routing-tab, so re-adding
 *  is just restoring the two rows). Renders nothing without curated metadata. */
const ModelMetrics = ({ model }: { model: PoolModel }) => {
    const parts: React.ReactNode[] = [];
    if (model.speedLabel) parts.push(<span key="sp">{model.speedLabel}</span>);
    if (model.contextLabel)
        parts.push(
            <span key="c" className="tabular-nums">
                {model.contextLabel}
            </span>,
        );
    if (parts.length === 0) return null;
    return (
        <span className="text-text-tertiary flex items-center gap-1.5 text-[11px]">
            {parts.map((p, i) => (
                <span key={i} className="flex items-center gap-1.5">
                    {i > 0 && <span className="opacity-40">·</span>}
                    {p}
                </span>
            ))}
        </span>
    );
};

/**
 * A model combobox (Popover + Command) reused for the default/fallback selects
 * and the per-agent pickers. When `gateTask` is set, each option runs the LIVE
 * capability gate (capabilityGate) — an incompatible option is DISABLED with a
 * tooltip explaining why, BEFORE save. The backend StaticTaskStrategy remains
 * the authoritative backstop. Every option row leads with the provider avatar.
 */
export const ModelCombobox = ({
    models,
    value,
    onSelect,
    trigger,
    gateTask,
    note,
    searchPlaceholder = "Search models…",
    emptyLabel = "No model found.",
    defaultOption,
}: {
    models: PoolModel[];
    value?: string;
    onSelect: (id: string) => void;
    trigger: React.ReactNode;
    gateTask?: LlmTask;
    /** A ripple note shown at the top of the list — e.g. "Also changes the tasks
     *  that inherit this one" — so the propagation is discoverable before a pick. */
    note?: string;
    searchPlaceholder?: string;
    emptyLabel?: string;
    /** When set, a "reset to inherited" row is rendered at the top of the list —
     *  the single control's way back to the inherited value, so the dropdown both
     *  sets and clears an override. `selected` is true when the row inherits. */
    defaultOption?: { label: string; selected: boolean; onSelect: () => void };
}) => {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");

    return (
        <Popover
            modal
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                // Reset the filter on close so the list doesn't reopen pre-filtered.
                if (!next) setSearch("");
            }}>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            <PopoverContent align="end" className="w-72 min-w-56 p-0">
                <Command
                    filter={(itemValue, term) => {
                        // The default row always matches so it stays reachable.
                        if (itemValue === "__default__") return 1;
                        const model = models.find((m) => m.id === itemValue);
                        if (!model) return 0;
                        return model.label
                            .toLowerCase()
                            .includes(term.toLowerCase())
                            ? 1
                            : 0;
                    }}>
                    <CommandInput
                        placeholder={searchPlaceholder}
                        value={search}
                        onValueChange={setSearch}
                    />
                    {note && (
                        <div className="text-text-tertiary border-card-lv2 border-b px-2.5 py-2 text-xs">
                            {note}
                        </div>
                    )}
                    <CommandList className="max-h-56 overflow-y-auto p-1">
                        <CommandEmpty>{emptyLabel}</CommandEmpty>
                        {defaultOption && (
                            <CommandItem
                                value="__default__"
                                onSelect={() => {
                                    defaultOption.onSelect();
                                    setOpen(false);
                                }}>
                                <span
                                    className={
                                        defaultOption.selected
                                            ? "text-primary font-medium"
                                            : "text-text-secondary"
                                    }>
                                    {defaultOption.label}
                                </span>
                            </CommandItem>
                        )}
                        {models.map((model) => {
                            const gate = gateTask
                                ? capabilityGate(
                                    gateTask,
                                    model.capabilities,
                                    model.label,
                                )
                                : { ok: true as const };
                            const selected = model.id === value;

                            const item = (
                                <CommandItem
                                    value={model.id}
                                    disabled={!gate.ok}
                                    onSelect={() => {
                                        if (!gate.ok) return;
                                        onSelect(model.id);
                                        setOpen(false);
                                    }}>
                                    <span className="flex min-w-0 items-center gap-2">
                                        {gate.ok ? (
                                            <ProviderAvatar
                                                provider={model.provider}
                                            />
                                        ) : (
                                            <AlertTriangleIcon className="text-warning size-3.5 shrink-0" />
                                        )}
                                        <span className="flex min-w-0 flex-col gap-0.5">
                                            <span
                                                dir="rtl"
                                                title={model.label}
                                                style={{ textAlign: "left" }}
                                                className={cn(
                                                    "truncate",
                                                    !gate.ok
                                                        ? "text-text-tertiary"
                                                        : selected
                                                            ? "text-primary font-medium"
                                                            : undefined,
                                                )}>
                                                {model.label}
                                            </span>
                                            {gate.ok && (
                                                <ModelMetrics model={model} />
                                            )}
                                        </span>
                                    </span>
                                </CommandItem>
                            );

                            // Disabled (incompatible) options carry a tooltip
                            // with the human reason — the LIVE pre-save warning.
                            if (!gate.ok && gate.reason) {
                                return (
                                    <Tooltip key={model.id}>
                                        <TooltipTrigger asChild>
                                            <span className="block">
                                                {item}
                                            </span>
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-64">
                                            {gate.reason}
                                        </TooltipContent>
                                    </Tooltip>
                                );
                            }

                            return (
                                <span key={model.id} className="block">
                                    {item}
                                </span>
                            );
                        })}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
};

/**
 * One task's model control: a dropdown whose trigger carries state — the
 * resolved model's provider avatar + a solid model name when overridden, or a
 * muted "Use default · X" when it inherits. Routing is FLAT: an un-overridden
 * agent always uses the org DEFAULT (no task→task chaining), so the inherited
 * state is uniformly "Use default". Reused by every agent card.
 */
const TaskModelControl = ({
    task,
    models,
    defaultModelId,
    taskOverrides,
    onChange,
}: {
    task: LlmTask;
    models: PoolModel[];
    defaultModelId?: string;
    taskOverrides: Partial<Record<LlmTask, string>>;
    onChange: (task: LlmTask, modelId: string | undefined) => void;
}) => {
    // Flat inheritance: with no override of its own, the task runs the org default.
    const inheritedId = defaultModelId;
    const rawOverrideId = taskOverrides[task];
    // An override equal to the default is redundant — treat it as inherited so
    // "override" and "use default" never look identical (and never re-pins).
    const overrideId =
        rawOverrideId && rawOverrideId !== inheritedId
            ? rawOverrideId
            : undefined;
    const overrideModel = models.find((m) => m.id === overrideId);
    const isCustom = !!overrideModel;
    const gate = overrideModel
        ? capabilityGate(task, overrideModel.capabilities, overrideModel.label)
        : { ok: true as const };

    // What actually runs — used for the avatar so the user sees the resolved
    // provider even when the value is inherited.
    const effectiveId = overrideId ?? inheritedId;
    const effectiveModel = models.find((m) => m.id === effectiveId);
    const inheritedLabel = modelLabelFor(models, inheritedId);
    const inheritedOptionLabel = `Use default · ${inheritedLabel}`;

    // The default model is already reachable via the "Use default" row — don't
    // ALSO list it as a standalone pick (picking it explicitly just collapses
    // back to inherited anyway).
    const pickableModels = models.filter((m) => m.id !== defaultModelId);

    return (
        <div className="flex shrink-0 items-center gap-2">
            {!gate.ok && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span className="inline-flex" tabIndex={0}>
                            <AlertTriangleIcon className="text-warning size-4" />
                        </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">
                        {gate.reason}
                    </TooltipContent>
                </Tooltip>
            )}
            <ModelCombobox
                models={pickableModels}
                value={overrideId}
                gateTask={task}
                onSelect={(id) => onChange(task, id)}
                defaultOption={{
                    label: inheritedOptionLabel,
                    selected: !isCustom,
                    onSelect: () => onChange(task, undefined),
                }}
                trigger={
                    <Button
                        variant="helper"
                        size="xs"
                        role="combobox"
                        className="min-w-64 justify-between gap-2"
                        rightIcon={
                            <ChevronsUpDownIcon className="-mr-1 opacity-50" />
                        }>
                        <span className="flex min-w-0 items-center gap-2">
                            <ProviderAvatar
                                provider={effectiveModel?.provider}
                            />
                            <span
                                dir="rtl"
                                title={
                                    isCustom
                                        ? modelLabelFor(models, overrideId)
                                        : inheritedOptionLabel
                                }
                                style={{ textAlign: "left" }}
                                className={
                                    isCustom
                                        ? "text-text-primary truncate"
                                        : "text-text-tertiary truncate font-normal"
                                }>
                                {isCustom
                                    ? modelLabelFor(models, overrideId)
                                    : inheritedOptionLabel}
                            </span>
                        </span>
                    </Button>
                }
            />
        </div>
    );
};

/** The 5 agent cards. Maps the 6 backend tasks onto the reference's agent
 *  framing: Kody Rules is ONE card holding its Review + Generation tasks; every
 *  other task is its own card. Nothing is hidden. */
type AgentCard = {
    task: LlmTask;
    Icon: LucideIcon;
    title: string;
    /** Overrides the task's default description — used where the card title isn't
     *  the raw task name (e.g. "Kody Rules" fronting the kodyRulesReview task). */
    desc?: string;
};

const AGENT_CARDS: AgentCard[] = [
    {
        task: "codeReview",
        Icon: GitPullRequestIcon,
        title: "Code Review",
    },
    {
        // Kody Rules routes ONE user-configurable task (kodyRulesReview) — rule
        // generation always inherits the default (TASK_ROUTING_FALLBACK →
        // codeReview). So it's a plain card, not a group with a lone "Review"
        // sub-row that read as redundant.
        task: "kodyRulesReview",
        Icon: ListChecksIcon,
        title: "Kody Rules",
        desc: "Applies your curated code-style rule packs.",
    },
    {
        task: "prSummary",
        Icon: FileTextIcon,
        title: "PR Summary",
    },
    {
        task: "conversation",
        Icon: MessageSquareIcon,
        title: "Conversation",
    },
    {
        task: "businessValidation",
        Icon: ShieldCheckIcon,
        title: "Business Rules",
    },
];

const IconTile = ({ Icon }: { Icon: LucideIcon }) => (
    <span className="bg-card-lv2 text-text-secondary flex size-9 shrink-0 items-center justify-center rounded-lg">
        <Icon className="size-4" />
    </span>
);

/**
 * The "Per agent" cards. Each Kody task is a card: an identity (icon + name +
 * one-line description) and a model control that carries its own state via the
 * provider avatar + value. Kody Rules groups its Review + Generation sub-rows in
 * one card. Backend is untouched — each control still writes taskOverrides[task].
 */
export const TaskOverrideGrid = (props: {
    models: PoolModel[];
    defaultModelId?: string;
    taskOverrides: Partial<Record<LlmTask, string>>;
    onChange: (task: LlmTask, modelId: string | undefined) => void;
}) => {
    return (
        <div className="flex flex-col gap-3">
            {AGENT_CARDS.map((card) => (
                <div
                    key={card.task}
                    data-routing-anchor={`task:${card.task}`}
                    className="border-card-lv3/50 bg-card-lv1 flex scroll-mt-4 flex-col gap-3 rounded-xl border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                            <IconTile Icon={card.Icon} />
                            <div className="flex min-w-0 flex-col">
                                <span className="text-text-primary text-sm font-medium">
                                    {card.title}
                                </span>
                                <span className="text-text-tertiary text-xs">
                                    {card.desc ?? TASK_DESCRIPTIONS[card.task]}
                                </span>
                            </div>
                        </div>
                        <TaskModelControl task={card.task} {...props} />
                    </div>
                </div>
            ))}
        </div>
    );
};
