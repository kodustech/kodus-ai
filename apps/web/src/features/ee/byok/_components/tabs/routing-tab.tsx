"use client";

import { useMemo, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardContent } from "@components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { toast } from "@components/ui/toaster/use-toast";
import {
    createOrUpdateOrganizationParameter,
    type LLMConfigStatus,
} from "@services/organizationParameters/fetch";
import { OrganizationParametersConfigKey } from "@services/parameters/types";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { ChevronsUpDownIcon } from "lucide-react";
import { useRouter } from "next/navigation";

import curatedCatalog from "../../_data/curated-models.json";
import type { CuratedModel } from "../../_data/curated-models.types";
import type { BYOKConfigV2, BYOKRouting, LlmTask } from "../../_types";
import { groupModelsByProvider } from "../../_utils";
import { buildV2Blob } from "../byok-v2-write";
import {
    ModelCombobox,
    TaskOverrideGrid,
    type PoolModel,
} from "../routing/task-override-grid";

type RoutingTabProps = {
    config: BYOKConfigV2 | null | undefined;
    llmConfigStatus: LLMConfigStatus | null;
};

const AUTO_TOOLTIP =
    "The auto-optimizing router is on the roadmap — your pool of models is ready for it.";

/** Curated display name for a model id, falling back to the raw id. */
const modelDisplayName = (modelId: string): string =>
    (curatedCatalog.models as CuratedModel[]).find((m) => m.id === modelId)
        ?.displayName ?? modelId;

/** Strip undefined task-override entries so the persisted routing is clean. */
const cleanOverrides = (
    overrides: Partial<Record<LlmTask, string>>,
): Partial<Record<LlmTask, string>> => {
    const out: Partial<Record<LlmTask, string>> = {};
    (Object.keys(overrides) as LlmTask[]).forEach((task) => {
        const id = overrides[task];
        if (id) out[task] = id;
    });
    return out;
};

/** Switch the parent BYOK Tabs to the Models panel (empty-state affordance). */
const goToModelsTab = () => {
    const tabs = Array.from(
        document.querySelectorAll<HTMLElement>('[role="tab"]'),
    );
    tabs.find((el) => el.textContent?.trim() === "Models")?.click();
};

/**
 * The Routing tab (04-10) — a POLICY chooser (D-UI-ROUTING): Manual (active) /
 * Auto (disabled "Coming soon"). Auto is a no-op; routing.mode is always written
 * 'manual' this slice. Default + Fallback selects bind routing.defaultModelId /
 * routing.fallbackModelId; the 3-row grid writes routing.taskOverrides[task] with
 * a LIVE capability warning (incompatible cells disabled with a tooltip before
 * save). Model capabilities arrive via the already-fetched llm-config/status.
 */
export const RoutingTab = ({ config, llmConfigStatus }: RoutingTabProps) => {
    const router = useRouter();

    // The connected pool, each model joined to its surfaced capabilities from the
    // (already-fetched) status response, matched by BYOKModelConfig.id.
    const pool = useMemo<PoolModel[]>(() => {
        const capsById = new Map(
            (llmConfigStatus?.models ?? []).map((m) => [m.modelId, m.capabilities]),
        );
        return groupModelsByProvider(config).flatMap((group) =>
            group.models.map((m) => ({
                id: m.id,
                label: modelDisplayName(m.model),
                capabilities: capsById.get(m.id),
            })),
        );
    }, [config, llmConfigStatus]);

    const routing = config?.routing ?? {};
    const [defaultModelId, setDefaultModelId] = useState<string | undefined>(
        routing.defaultModelId,
    );
    const [fallbackModelId, setFallbackModelId] = useState<string | undefined>(
        routing.fallbackModelId,
    );
    const [showFallback, setShowFallback] = useState<boolean>(
        !!routing.fallbackModelId,
    );
    const [taskOverrides, setTaskOverrides] = useState<
        Partial<Record<LlmTask, string>>
    >(routing.taskOverrides ?? {});
    const [isSaving, setIsSaving] = useState(false);

    const labelFor = (id?: string) =>
        pool.find((m) => m.id === id)?.label ?? id;

    // Empty state — reachable only via deep-link (the tab is disabled at
    // first-run). Routing needs at least one model to route to.
    if (pool.length === 0) {
        return (
            <Card color="lv1">
                <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                    <p className="text-text-secondary text-sm text-balance">
                        Connect a model first — routing needs at least one model
                        to route to.
                    </p>
                    <Button variant="primary" size="md" onClick={goToModelsTab}>
                        Go to Models
                    </Button>
                </CardContent>
            </Card>
        );
    }

    const nextRouting = (): BYOKRouting => ({
        mode: "manual",
        defaultModelId: defaultModelId || undefined,
        fallbackModelId:
            showFallback && fallbackModelId ? fallbackModelId : undefined,
        taskOverrides: cleanOverrides(taskOverrides),
    });

    const dirty =
        JSON.stringify(nextRouting()) !==
        JSON.stringify({
            mode: "manual",
            defaultModelId: routing.defaultModelId || undefined,
            fallbackModelId: routing.fallbackModelId || undefined,
            taskOverrides: cleanOverrides(routing.taskOverrides ?? {}),
        });

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await createOrUpdateOrganizationParameter(
                OrganizationParametersConfigKey.BYOK_CONFIG,
                buildV2Blob(config, { kind: "routing", routing: nextRouting() }),
            );
            toast({ variant: "success", title: "Routing saved" });
            router.refresh();
        } catch {
            toast({ variant: "danger", title: "Couldn't save routing" });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <TooltipProvider>
            <div className="flex flex-col gap-6">
                {/* ── Policy chooser: Manual (active) / Auto (coming soon) ── */}
                <div className="flex flex-col gap-2">
                    <span className="text-text-primary text-sm font-medium">
                        Routing policy
                    </span>
                    <ToggleGroup.Root
                        type="single"
                        value="manual"
                        className="bg-card-lv2 grid grid-cols-2 gap-px overflow-hidden rounded-lg p-0.5">
                        <ToggleGroup.Item
                            value="manual"
                            className="text-text-secondary data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:ring-primary/40 data-[state=on]:shadow-sm rounded-md px-3 py-2 text-xs font-medium transition-colors data-[state=on]:ring-1">
                            Manual · you choose
                        </ToggleGroup.Item>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span
                                    className="inline-flex"
                                    tabIndex={0}
                                    aria-disabled>
                                    <ToggleGroup.Item
                                        value="auto"
                                        disabled
                                        className="text-text-tertiary flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium disabled:cursor-not-allowed">
                                        Auto · Kodus optimizes
                                        <Badge variant="helper">
                                            Coming soon
                                        </Badge>
                                    </ToggleGroup.Item>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-64">
                                {AUTO_TOOLTIP}
                            </TooltipContent>
                        </Tooltip>
                    </ToggleGroup.Root>
                </div>

                {/* ── Default + Fallback ── */}
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-col">
                            <span className="text-text-primary text-sm font-medium">
                                Default model
                            </span>
                            <span className="text-text-tertiary text-xs">
                                Used when a task has no override.
                            </span>
                        </div>
                        <ModelCombobox
                            models={pool}
                            value={defaultModelId}
                            onSelect={setDefaultModelId}
                            trigger={
                                <Button
                                    variant="helper"
                                    size="md"
                                    role="combobox"
                                    className="min-w-56 justify-between"
                                    rightIcon={
                                        <ChevronsUpDownIcon className="-mr-2 opacity-50" />
                                    }>
                                    {labelFor(defaultModelId) ??
                                        "Select a model"}
                                </Button>
                            }
                        />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-col">
                            <span className="text-text-primary text-sm font-medium">
                                Fallback (optional)
                            </span>
                            <span className="text-text-tertiary text-xs">
                                Used if the resolved model fails.
                            </span>
                        </div>
                        {showFallback ? (
                            <div className="flex items-center gap-2">
                                <ModelCombobox
                                    models={pool}
                                    value={fallbackModelId}
                                    onSelect={setFallbackModelId}
                                    trigger={
                                        <Button
                                            variant="helper"
                                            size="md"
                                            role="combobox"
                                            className="min-w-56 justify-between"
                                            rightIcon={
                                                <ChevronsUpDownIcon className="-mr-2 opacity-50" />
                                            }>
                                            {labelFor(fallbackModelId) ??
                                                "Select a model"}
                                        </Button>
                                    }
                                />
                                <Button
                                    variant="tertiary"
                                    size="xs"
                                    onClick={() => {
                                        setShowFallback(false);
                                        setFallbackModelId(undefined);
                                    }}>
                                    Remove
                                </Button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2">
                                <span className="text-text-tertiary text-sm">
                                    — none —
                                </span>
                                <Button
                                    variant="helper"
                                    size="xs"
                                    onClick={() => setShowFallback(true)}>
                                    Add fallback
                                </Button>
                            </div>
                        )}
                    </div>
                </div>

                {/* ── Per-task override grid (live capability warning) ── */}
                <div className="flex flex-col gap-2">
                    <span className="text-text-primary text-sm font-medium">
                        Per-task models
                    </span>
                    <TaskOverrideGrid
                        models={pool}
                        defaultModelId={defaultModelId}
                        taskOverrides={taskOverrides}
                        onChange={(task, modelId) =>
                            setTaskOverrides((prev) => {
                                const next = { ...prev };
                                if (modelId) next[task] = modelId;
                                else delete next[task];
                                return next;
                            })
                        }
                    />
                </div>

                <div className="flex justify-end">
                    <Button
                        variant="primary"
                        size="md"
                        disabled={!dirty || isSaving}
                        loading={isSaving}
                        onClick={handleSave}>
                        Save routing
                    </Button>
                </div>
            </div>
        </TooltipProvider>
    );
};
