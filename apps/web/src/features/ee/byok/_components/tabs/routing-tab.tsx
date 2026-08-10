"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import {
    ChevronsUpDownIcon,
    Layers3Icon,
    SlidersHorizontalIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { TASK_ROUTING_FALLBACK } from "@libs/llm/byok-config";

import curatedCatalog from "../../_data/curated-models.json";
import type { CuratedModel } from "../../_data/curated-models.types";
import type { BYOKConfig, BYOKRouting, LlmTask } from "../../_types";
import { groupModelsByProvider } from "../../_utils";
import { buildByokBlob } from "../byok-write";
import { PerRepositoryPanel } from "../per-repository-panel";
import { ProviderAvatar } from "../provider-avatar";
import {
    ModelCombobox,
    TaskOverrideGrid,
    type PoolModel,
} from "../routing/task-override-grid";

type RoutingTabProps = {
    config: BYOKConfig | null | undefined;
    llmConfigStatus: LLMConfigStatus | null;
    /** Drives the read-only Per-repository mirror (listModelOverrides). */
    teamId?: string;
    /** Switch the parent BYOK Tabs to the Providers panel (empty-state
     *  affordance). Supplied by the controlled Tabs in page.client. */
    onGoToProviders: () => void;
    /** Deep-link target set when a Providers-tab "Used in" chip is clicked:
     *  "default" | "fallback" | `task:${LlmTask}`. Scrolled to + flashed on
     *  mount, then cleared via `onScrolled`. */
    scrollAnchor?: string | null;
    onScrolled?: () => void;
};

const AUTO_TOOLTIP =
    "The auto-optimizing router is on the roadmap — your pool of models is ready for it.";

/** Curated display name for a model id, falling back to the raw id. */
const modelDisplayName = (modelId: string): string =>
    (curatedCatalog.models as CuratedModel[]).find((m) => m.id === modelId)
        ?.displayName ?? modelId;

/**
 * Strip task-override entries that shouldn't persist: empty ids AND overrides
 * equal to what the row would inherit anyway — the org default, OR (for a task
 * that inherits another) its parent task's model. Such an override is displayed
 * as "inherited" by the grid, so persisting it would silently re-pin the row if
 * the inherited source later moves (e.g. a child pinned to Code Review's current
 * model would strand as "Custom" when Code Review changes). Mirroring the grid's
 * collapse-to-inherited here keeps the saved blob matching what the UI shows.
 * Applied to both the serialized routing and the dirty-check baseline so the two
 * stay consistent.
 */
const cleanOverrides = (
    overrides: Partial<Record<LlmTask, string>>,
    defaultModelId?: string,
): Partial<Record<LlmTask, string>> => {
    const out: Partial<Record<LlmTask, string>> = {};
    (Object.keys(overrides) as LlmTask[]).forEach((task) => {
        const id = overrides[task];
        if (!id) return;
        const parent = TASK_ROUTING_FALLBACK[task];
        const inheritedId = parent
            ? (overrides[parent] ?? defaultModelId)
            : defaultModelId;
        if (id !== inheritedId) out[task] = id;
    });
    return out;
};

/**
 * The Routing tab (04-10) — a POLICY chooser (D-UI-ROUTING): Manual (active) /
 * Auto (disabled "Coming soon"). Auto is a no-op; routing.mode is always written
 * 'manual' this slice. Default + Fallback selects bind routing.defaultModelId /
 * routing.fallbackModelId; the 3-row grid writes routing.taskOverrides[task] with
 * a LIVE capability warning (incompatible cells disabled with a tooltip before
 * save). Model capabilities arrive via the already-fetched llm-config/status.
 */
export const RoutingTab = ({
    config,
    llmConfigStatus,
    teamId,
    onGoToProviders,
    scrollAnchor,
    onScrolled,
}: RoutingTabProps) => {
    const router = useRouter();

    // Scroll to (and briefly flash) the row a "Used in" chip deep-linked to.
    // Runs on mount because the tab switch remounts this panel with the anchor
    // already set; a rAF lets layout settle before scrollIntoView. The captured
    // element drives the flash-off timer, so clearing `scrollAnchor` in the
    // parent (via onScrolled) can't strand the ring.
    const rowsRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!scrollAnchor) return;
        const FLASH = ["ring-primary/60", "ring-2", "rounded-lg"];
        // The flash-off timer lives INSIDE the rAF and is intentionally not torn
        // down by cleanup: `onScrolled` clears the anchor in the parent, which
        // would otherwise re-run cleanup and strip the ring the instant it lands.
        const raf = requestAnimationFrame(() => {
            const el = rowsRef.current?.querySelector<HTMLElement>(
                `[data-routing-anchor="${scrollAnchor}"]`,
            );
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
            el?.classList.add(...FLASH);
            setTimeout(() => el?.classList.remove(...FLASH), 1600);
            onScrolled?.();
        });
        return () => cancelAnimationFrame(raf);
        // Only re-run when the requested anchor changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scrollAnchor]);

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
                provider: group.credential.provider,
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
    const providerOf = (id?: string) =>
        pool.find((m) => m.id === id)?.provider;

    // Empty state — the Routing tab stays reachable at first-run, so this shows
    // whenever no model is connected yet. Routing needs at least one model to
    // route to; the button hands control back to the Providers tab.
    if (pool.length === 0) {
        return (
            <Card color="lv1">
                <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                    <p className="text-text-secondary text-sm text-balance">
                        Connect a provider first — routing needs at least one
                        model to route to.
                    </p>
                    <Button
                        variant="primary"
                        size="md"
                        onClick={onGoToProviders}>
                        Go to Providers
                    </Button>
                </CardContent>
            </Card>
        );
    }

    // Single-model degeneracy: default, fallback and every per-task row can only
    // resolve to the one model, so the whole grid is redundant (this is the
    // "default == override" confusion). Routing needs ≥2 models to mean anything.
    if (pool.length === 1) {
        const only = pool[0];
        return (
            <Card color="lv1">
                <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                    <p className="text-text-secondary text-sm text-balance">
                        Every task uses{" "}
                        <strong className="text-text-primary">
                            {only.label}
                        </strong>{" "}
                        — your only connected model.
                    </p>
                    <p className="text-text-tertiary text-xs text-balance">
                        Connect a second model to route different tasks (code
                        review, Kody Rules, chat, and more) to different models.
                    </p>
                    <Button
                        variant="primary"
                        size="md"
                        onClick={onGoToProviders}>
                        Connect another model
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
        taskOverrides: cleanOverrides(taskOverrides, defaultModelId || undefined),
    });

    const dirty =
        JSON.stringify(nextRouting()) !==
        JSON.stringify({
            mode: "manual",
            defaultModelId: routing.defaultModelId || undefined,
            fallbackModelId: routing.fallbackModelId || undefined,
            taskOverrides: cleanOverrides(
                routing.taskOverrides ?? {},
                routing.defaultModelId || undefined,
            ),
        });

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await createOrUpdateOrganizationParameter(
                OrganizationParametersConfigKey.BYOK_CONFIG,
                buildByokBlob(config, { kind: "routing", routing: nextRouting() }),
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
            <div ref={rowsRef} className="flex flex-col gap-6">
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
                                    className="inline-flex opacity-50"
                                    tabIndex={0}
                                    aria-disabled>
                                    <ToggleGroup.Item
                                        value="auto"
                                        disabled
                                        className="text-text-tertiary flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-normal disabled:cursor-not-allowed">
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

                {/* ── Defaults: one model for everything + fallback ── */}
                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-0.5">
                        <span className="text-text-primary flex items-center gap-2 text-sm font-medium">
                            <Layers3Icon className="text-primary-light size-4" />
                            Defaults
                        </span>
                        <span className="text-text-tertiary text-xs">
                            The model every task uses until you override it per
                            agent below.
                        </span>
                    </div>
                    <div className="border-card-lv3/50 bg-card-lv1 flex flex-col gap-4 rounded-xl border p-4">
                    <div
                        data-routing-anchor="default"
                        className="flex flex-wrap items-center justify-between gap-3 scroll-mt-4">
                        <div className="flex flex-col">
                            <span className="text-text-primary text-sm font-medium">
                                Model for all tasks
                            </span>
                            <span className="text-text-tertiary text-xs">
                                Runs every task unless you set one per agent below.
                            </span>
                        </div>
                        <ModelCombobox
                            models={pool}
                            value={defaultModelId}
                            onSelect={(id) => {
                                setDefaultModelId(id);
                                // Drop per-task overrides that now equal the new
                                // default — they inherit, so they must not stay
                                // pinned (else they'd re-surface if it moves again).
                                setTaskOverrides((prev) => {
                                    const next = { ...prev };
                                    (Object.keys(next) as LlmTask[]).forEach(
                                        (task) => {
                                            if (next[task] === id)
                                                delete next[task];
                                        },
                                    );
                                    return next;
                                });
                            }}
                            trigger={
                                <Button
                                    variant="helper"
                                    size="md"
                                    role="combobox"
                                    className="min-w-64 justify-between gap-2"
                                    rightIcon={
                                        <ChevronsUpDownIcon className="-mr-2 opacity-50" />
                                    }>
                                    <span className="flex min-w-0 items-center gap-2">
                                        <ProviderAvatar
                                            provider={providerOf(defaultModelId)}
                                        />
                                        <span className="truncate">
                                            {labelFor(defaultModelId) ??
                                                "Select a model"}
                                        </span>
                                    </span>
                                </Button>
                            }
                        />
                    </div>

                    <div
                        data-routing-anchor="fallback"
                        className="flex flex-wrap items-center justify-between gap-3 scroll-mt-4">
                        <div className="flex flex-col">
                            <span className="text-text-primary text-sm font-medium">
                                Fallback (optional)
                            </span>
                            <span className="text-text-tertiary text-xs">
                                Used automatically if the main model is
                                unavailable.
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
                                            className="min-w-56 justify-between gap-2"
                                            rightIcon={
                                                <ChevronsUpDownIcon className="-mr-2 opacity-50" />
                                            }>
                                            <span className="flex min-w-0 items-center gap-2">
                                                <ProviderAvatar
                                                    provider={providerOf(
                                                        fallbackModelId,
                                                    )}
                                                />
                                                <span className="truncate">
                                                    {labelFor(fallbackModelId) ??
                                                        "Select a model"}
                                                </span>
                                            </span>
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
                </div>

                {/* ── Per agent — different tasks can run different models ── */}
                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-0.5">
                        <span className="text-text-primary flex items-center gap-2 text-sm font-medium">
                            <SlidersHorizontalIcon className="text-success size-4" />
                            Per agent
                        </span>
                        <span className="text-text-tertiary text-xs">
                            Different Kody tasks can run different models — a
                            pricier model for deep review, a cheaper one for
                            summaries.
                        </span>
                    </div>
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

                {/* ── Per repository (read-only mirror of Code Review Settings) ── */}
                <PerRepositoryPanel teamId={teamId} />
            </div>
        </TooltipProvider>
    );
};
