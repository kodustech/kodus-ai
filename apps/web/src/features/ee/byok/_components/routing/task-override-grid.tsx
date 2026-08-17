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
import { TASK_ROUTING_FALLBACK } from "@libs/llm/byok-config";
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

import type { LlmTask } from "../../_types";
import { modelLabelFor, TASK_DESCRIPTIONS, TASK_LABELS } from "../../_utils";
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
                                    <span className="flex items-center gap-2">
                                        {gate.ok ? (
                                            <ProviderAvatar
                                                provider={model.provider}
                                            />
                                        ) : (
                                            <AlertTriangleIcon className="text-warning size-3.5 shrink-0" />
                                        )}
                                        <span
                                            className={
                                                !gate.ok
                                                    ? "text-text-tertiary"
                                                    : selected
                                                        ? "text-primary font-medium"
                                                        : undefined
                                            }>
                                            {model.label}
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

// child → parent inheritance map, shared with the backend resolver (one source
// of truth for the whole feature).
const TASK_INHERITS = TASK_ROUTING_FALLBACK;

// Parent task → the tasks that inherit it (inverse of TASK_INHERITS), for the
// "changing this also updates …" ripple note. Derived once.
const CHILDREN_OF: Partial<Record<LlmTask, LlmTask[]>> = Object.entries(
    TASK_INHERITS,
).reduce<Partial<Record<LlmTask, LlmTask[]>>>((acc, [child, parent]) => {
    (acc[parent as LlmTask] ??= []).push(child as LlmTask);
    return acc;
}, {});

/**
 * One task's model control: a dropdown whose trigger carries state — the
 * resolved model's provider avatar + a solid model name when overridden, or a
 * muted "Same as Code Review · X" / "Use default · X" when it inherits. Reused by
 * the single-agent cards AND the Kody Rules sub-rows, so the picker logic lives
 * in one place.
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
    const inheritsFrom = TASK_INHERITS[task];
    const inheritedId = inheritsFrom
        ? (taskOverrides[inheritsFrom] ?? defaultModelId)
        : defaultModelId;
    const rawOverrideId = taskOverrides[task];
    // An override equal to what the row would inherit anyway is redundant —
    // treat it as inherited so the two states never look identical.
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
    const inheritedOptionLabel = inheritsFrom
        ? `Same as ${TASK_LABELS[inheritsFrom]} · ${inheritedLabel}`
        : `Use default · ${inheritedLabel}`;

    // Ripple note: children that currently follow this task move when its model
    // changes.
    const followingChildren = (CHILDREN_OF[task] ?? []).filter((child) => {
        const own = taskOverrides[child];
        return !own || own === effectiveId;
    });
    const note =
        followingChildren.length > 0
            ? `Changing this also updates ${followingChildren
                .map((c) => TASK_LABELS[c])
                .join(", ")}, which follow it.`
            : undefined;

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
                models={models}
                value={overrideId}
                gateTask={task}
                note={note}
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
type AgentCard =
    | { kind: "single"; task: LlmTask; Icon: LucideIcon; title: string }
    | {
        kind: "group";
        key: string;
        Icon: LucideIcon;
        title: string;
        desc: string;
        subtasks: { task: LlmTask; label: string }[];
    };

const AGENT_CARDS: AgentCard[] = [
    {
        kind: "single",
        task: "codeReview",
        Icon: GitPullRequestIcon,
        title: "Code Review",
    },
    {
        kind: "group",
        key: "kodyRules",
        Icon: ListChecksIcon,
        title: "Kody Rules",
        desc: "Applies your curated code-style rule packs.",
        subtasks: [
            { task: "kodyRulesReview", label: "Review" },
            // Rule generation ("learning") is not independently routable for now:
            // it always inherits the default (via TASK_ROUTING_FALLBACK →
            // codeReview). Only the Review sub-task is user-configurable here.
        ],
    },
    {
        kind: "single",
        task: "prSummary",
        Icon: FileTextIcon,
        title: "PR Summary",
    },
    {
        kind: "single",
        task: "conversation",
        Icon: MessageSquareIcon,
        title: "Conversation",
    },
    {
        kind: "single",
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
                    key={card.kind === "single" ? card.task : card.key}
                    data-routing-anchor={`task:${card.kind === "single" ? card.task : card.key
                        }`}
                    className="border-card-lv3/50 bg-card-lv1 flex scroll-mt-4 flex-col gap-3 rounded-xl border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                            <IconTile Icon={card.Icon} />
                            <div className="flex min-w-0 flex-col">
                                <span className="text-text-primary text-sm font-medium">
                                    {card.title}
                                </span>
                                <span className="text-text-tertiary text-xs">
                                    {card.kind === "single"
                                        ? TASK_DESCRIPTIONS[card.task]
                                        : card.desc}
                                </span>
                            </div>
                        </div>
                        {card.kind === "single" && (
                            <TaskModelControl task={card.task} {...props} />
                        )}
                    </div>

                    {card.kind === "group" && (
                        <div className="border-card-lv3/40 ml-12 flex flex-col gap-2 border-l pl-4">
                            {card.subtasks.map((st) => (
                                <div
                                    key={st.task}
                                    data-routing-anchor={`task:${st.task}`}
                                    className="flex scroll-mt-4 flex-wrap items-center justify-between gap-3">
                                    <span className="text-text-secondary text-xs">
                                        {st.label}
                                    </span>
                                    <TaskModelControl
                                        task={st.task}
                                        {...props}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
};
