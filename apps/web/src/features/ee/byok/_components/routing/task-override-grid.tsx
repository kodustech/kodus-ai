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
import { AlertTriangleIcon, ChevronsUpDownIcon } from "lucide-react";

import type { LlmTask } from "../../_types";
import { TASK_LABELS } from "../../_utils";
import { capabilityGate, type SurfacedCapabilities } from "./capability-gate";

/** One selectable model in the connected pool (a BYOKModelConfig projected for
 *  the routing selects). `id` is the BYOKModelConfig.id routing writes. */
export type PoolModel = {
    id: string;
    label: string;
    capabilities?: SurfacedCapabilities;
};

/**
 * A model combobox (Popover + Command) reused for the default/fallback selects
 * and the per-task override pickers. When `gateTask` is set, each option runs the
 * LIVE capability gate (capabilityGate) — an incompatible option is DISABLED with
 * a tooltip explaining why, BEFORE save. The backend StaticTaskStrategy remains
 * the authoritative backstop.
 */
export const ModelCombobox = ({
    models,
    value,
    onSelect,
    trigger,
    gateTask,
    searchPlaceholder = "Search models…",
    emptyLabel = "No model found.",
}: {
    models: PoolModel[];
    value?: string;
    onSelect: (id: string) => void;
    trigger: React.ReactNode;
    gateTask?: LlmTask;
    searchPlaceholder?: string;
    emptyLabel?: string;
}) => {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");

    return (
        <Popover modal open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            <PopoverContent
                align="start"
                className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0">
                <Command
                    filter={(itemValue, term) => {
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
                    <CommandList className="max-h-56 overflow-y-auto p-1">
                        <CommandEmpty>{emptyLabel}</CommandEmpty>
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
                                        {!gate.ok && (
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

const TASK_ROWS: { task: LlmTask; label: string }[] = (
    ["codeReview", "prSummary", "conversation"] as LlmTask[]
).map((task) => ({ task, label: TASK_LABELS[task] }));

/**
 * The 3-row per-task override grid (codeReview / prSummary / conversation). Each
 * row is a closed "Uses default (…)" state with an [Override]; once overridden it
 * shows the picked model with [Change] + [Reset to default], writing
 * routing.taskOverrides[task]. Each row's picker runs the LIVE capability gate,
 * and an already-selected override that becomes incompatible is marked inline.
 */
export const TaskOverrideGrid = ({
    models,
    defaultModelId,
    taskOverrides,
    onChange,
}: {
    models: PoolModel[];
    defaultModelId?: string;
    taskOverrides: Partial<Record<LlmTask, string>>;
    onChange: (task: LlmTask, modelId: string | undefined) => void;
}) => {
    const labelFor = (id?: string) =>
        models.find((m) => m.id === id)?.label ?? id ?? "—";

    return (
        <div className="border-card-lv2 divide-card-lv2 flex flex-col divide-y rounded-lg border">
            {TASK_ROWS.map(({ task, label }) => {
                const rawOverrideId = taskOverrides[task];
                // An override equal to the default is redundant — render it as
                // "uses default" so the two states never look identical (the
                // default==override confusion).
                const overrideId =
                    rawOverrideId && rawOverrideId !== defaultModelId
                        ? rawOverrideId
                        : undefined;
                const overrideModel = models.find((m) => m.id === overrideId);
                const gate = overrideModel
                    ? capabilityGate(
                          task,
                          overrideModel.capabilities,
                          overrideModel.label,
                      )
                    : { ok: true as const };

                return (
                    <div
                        key={task}
                        className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                        <span className="text-text-primary text-sm font-medium">
                            {label}
                        </span>

                        {overrideModel ? (
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-text-secondary flex items-center gap-1.5 text-sm">
                                    {!gate.ok && (
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <span
                                                    className="inline-flex"
                                                    tabIndex={0}>
                                                    <AlertTriangleIcon className="text-warning size-4" />
                                                </span>
                                            </TooltipTrigger>
                                            <TooltipContent className="max-w-64">
                                                {gate.reason}
                                            </TooltipContent>
                                        </Tooltip>
                                    )}
                                    {labelFor(overrideId)}
                                </span>
                                <ModelCombobox
                                    models={models}
                                    value={overrideId}
                                    gateTask={task}
                                    onSelect={(id) => onChange(task, id)}
                                    trigger={
                                        <Button
                                            variant="tertiary"
                                            size="xs"
                                            role="combobox"
                                            rightIcon={
                                                <ChevronsUpDownIcon className="opacity-50" />
                                            }>
                                            Change
                                        </Button>
                                    }
                                />
                                <Button
                                    variant="tertiary"
                                    size="xs"
                                    onClick={() => onChange(task, undefined)}>
                                    Reset to default
                                </Button>
                            </div>
                        ) : (
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-text-tertiary text-sm">
                                    Uses default ({labelFor(defaultModelId)})
                                </span>
                                <ModelCombobox
                                    models={models}
                                    gateTask={task}
                                    onSelect={(id) => onChange(task, id)}
                                    trigger={
                                        <Button
                                            variant="helper"
                                            size="xs"
                                            role="combobox">
                                            Override
                                        </Button>
                                    }
                                />
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};
