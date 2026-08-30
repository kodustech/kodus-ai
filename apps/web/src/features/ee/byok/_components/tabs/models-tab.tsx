"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { type LLMConfigStatus } from "@services/organizationParameters/fetch";
import type { ByokModelCost } from "@services/usage/byok-cost";
import { PlusIcon } from "lucide-react";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import type { BYOKConfig, BYOKCredential, BYOKModelConfig } from "../../_types";
import { groupModelsByProvider, hasVisibleModels } from "../../_utils";
import { ConnectProviderFlow } from "../connect-provider-flow";
import { FirstRunCard } from "../first-run-card";
import { ModelRow } from "../model-row";
import { ProviderGroupHeader } from "../provider-group-header";

type ModelsTabProps = {
    config: BYOKConfig | null | undefined;
    /** Per-model accumulated cost, keyed by BYOKModelConfig.id. */
    costByModelId?: Record<string, ByokModelCost>;
    teamId?: string;
    periodLabel?: string;
    costRangeQuery?: string;
    llmConfigStatus: LLMConfigStatus | null;
    /** Deep-link a model's "Used in" chip to its Routing-tab row. */
    onOpenRouting?: (anchor: string) => void;
};

type View =
    | { mode: "list" }
    // `provider` set ⇒ scoped "Add a model to {provider}" (key reused);
    // absent ⇒ "Add another provider" (provider grid first).
    | { mode: "add"; provider?: string };

/**
 * The interactive Models tab: first-run single-decision card, or the
 * provider-grouped steady-state pool with add-model (key deduped by provider),
 * rotate-key, and per-model config edit. Every write builds a v2 BYOKConfig
 * blob (blank-key keep rule) and posts it through create-or-update.
 */
export const ModelsTab = ({
    config,
    costByModelId,
    periodLabel,
    costRangeQuery,
    onOpenRouting,
}: ModelsTabProps) => {
    const router = useRouter();
    const [view, setView] = useState<View>({ mode: "list" });

    const groups = groupModelsByProvider(config).filter(
        (g) => g.models.length > 0,
    );
    const firstRun = !hasVisibleModels(config);

    // ── add model / add provider (dedup key by provider) ──────────────────────
    const connectedKeyByProvider: Record<string, string> = {};
    // Models connected per provider — surfaced on the connect grid's "Connected"
    // card ("Connected · N models"). Summed across a provider's credentials.
    const connectedModelCountByProvider: Record<string, number> = {};
    for (const group of groupModelsByProvider(config)) {
        connectedKeyByProvider[group.credential.provider] =
            group.credential.apiKey ?? "••••";
        connectedModelCountByProvider[group.credential.provider] =
            (connectedModelCountByProvider[group.credential.provider] ?? 0) +
            group.models.length;
    }

    // ── per-model edit ────────────────────────────────────────────────────────
    // ONE editor for every model, curated or not: the unified manual form (it
    // carries the inline model picker, the in-use lock, the plan toggle, per-
    // provider creds, the Test probe and save). Pre-filled in place via ?model=.
    const openEdit = (model: BYOKModelConfig, _credential: BYOKCredential) => {
        router.push(`/byok/manual?model=${encodeURIComponent(model.id)}`);
    };

    // ── delete → the 04-09 flow (confirm + in-use reason Alert + last-model
    //    disconnect) lives in delete-model-flow via ModelRow. The tab only needs
    //    to refresh the pool once a model is actually removed.
    const handleDeleted = async () => {
        await revalidateServerSidePath("/byok");
        router.refresh();
    };

    // ── view: add model (provider-scoped) / add another provider (grid) ───────
    // Both use the shared PROVIDER-FIRST flow: with `lockedProvider` it skips the
    // grid and reuses the stored key; without it, the provider grid comes first.
    if (view.mode === "add") {
        return (
            <ConnectProviderFlow
                existingKeyByProvider={connectedKeyByProvider}
                connectedModelCountByProvider={connectedModelCountByProvider}
                lockedProvider={view.provider}
                onCancel={() => setView({ mode: "list" })}
            />
        );
    }

    // ── view: first-run ───────────────────────────────────────────────────────
    if (firstRun) {
        return <FirstRunCard />;
    }

    // ── view: steady-state provider-grouped pool ──────────────────────────────
    const totalModels = groups.reduce((sum, g) => sum + g.models.length, 0);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-baseline gap-2">
                    <h2 className="text-text-primary text-sm font-semibold">
                        Connected providers
                    </h2>
                    <span className="text-text-tertiary text-xs tabular-nums">
                        {groups.length}{" "}
                        {groups.length === 1 ? "provider" : "providers"} ·{" "}
                        {totalModels} {totalModels === 1 ? "model" : "models"}
                    </span>
                </div>
                {/* List-level action lives in the section header (top-right) —
                    always visible, and primary weight is right for the main
                    "connect a provider" action. */}
                <Button
                    size="sm"
                    variant="primary"
                    leftIcon={<PlusIcon />}
                    onClick={() => setView({ mode: "add" })}>
                    Add another provider
                </Button>
            </div>

            {groups.map(({ credential, models }) => (
                <ProviderGroupHeader
                    key={credential.id}
                    credential={credential}
                    modelCount={models.length}
                    defaultOpen={groups.length <= 1 || models.length <= 3}
                    onRotate={() =>
                        router.push(
                            `/byok/provider?credentialId=${encodeURIComponent(credential.id)}`,
                        )
                    }>
                    <div className="flex flex-col gap-3 pt-1">
                        {models.map((model) => (
                            <ModelRow
                                key={model.id}
                                model={model}
                                config={config}
                                cost={costByModelId?.[model.id]}
                                periodLabel={periodLabel}
                                costRangeQuery={costRangeQuery}
                                onEdit={() => openEdit(model, credential)}
                                onDeleted={handleDeleted}
                                onOpenRouting={onOpenRouting}
                            />
                        ))}
                        <div className="flex justify-end">
                            <Button
                                size="xs"
                                variant="helper"
                                leftIcon={<PlusIcon />}
                                onClick={() =>
                                    // Adding a model to a CONNECTED provider is a
                                    // SELECTION task, not discovery: the provider is
                                    // already chosen + keyed, so go straight to the
                                    // model picker scoped to it — a live dropdown of
                                    // the provider's REAL models (key reused, provider
                                    // locked), not our curated marketing cards. The
                                    // curated cards stay for FIRST connect ("Add
                                    // another provider"), where discovery guidance
                                    // earns its place.
                                    router.push(
                                        `/byok/manual?provider=${encodeURIComponent(credential.provider)}`,
                                    )
                                }>
                                Add model
                            </Button>
                        </div>
                    </div>
                </ProviderGroupHeader>
            ))}
        </div>
    );
};
