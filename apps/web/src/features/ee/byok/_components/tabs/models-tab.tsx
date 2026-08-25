"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Textarea } from "@components/ui/textarea";
import { toast } from "@components/ui/toaster/use-toast";
import {
    createOrUpdateOrganizationParameter,
    testBYOK,
    type LLMConfigStatus,
    type TestBYOKResult,
} from "@services/organizationParameters/fetch";
import { OrganizationParametersConfigKey } from "@services/parameters/types";
import type { ByokModelCost } from "@services/usage/byok-cost";
import { PlugIcon, PlusIcon } from "lucide-react";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import { useCatalog } from "../../_data/catalog-context";
import type {
    BYOKConfig,
    BYOKConnectInput,
    BYOKCredential,
    BYOKModelConfig,
} from "../../_types";
import { groupModelsByProvider, hasVisibleModels, maskKey } from "../../_utils";
import {
    buildByokBlob,
    credentialSettingsFromConfig,
    modelFieldsFromConfig,
} from "../byok-write";
import { PROVIDER_LABELS } from "../catalog/model-card";
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
    | { mode: "add"; provider?: string }
    | { mode: "rotate"; credential: BYOKCredential };

/**
 * The interactive Models tab: first-run single-decision card, or the
 * provider-grouped steady-state pool with add-model (key deduped by provider),
 * rotate-key, and per-model config edit. Every write builds a v2 BYOKConfig
 * blob (blank-key keep rule) and posts it through create-or-update.
 */
export const ModelsTab = ({
    config,
    costByModelId,
    teamId,
    periodLabel,
    costRangeQuery,
    onOpenRouting,
}: ModelsTabProps) => {
    const router = useRouter();
    const [view, setView] = useState<View>({ mode: "list" });

    const catalog = useCatalog();
    const displayNameFor = (modelId: string): string =>
        catalog.find((m) => m.id === modelId)?.displayName ?? modelId;

    const groups = groupModelsByProvider(config).filter(
        (g) => g.models.length > 0,
    );
    const firstRun = !hasVisibleModels(config);

    const persist = async (blob: BYOKConfig, successTitle: string) => {
        try {
            await createOrUpdateOrganizationParameter(
                OrganizationParametersConfigKey.BYOK_CONFIG,
                blob,
            );
            toast({ variant: "success", title: successTitle });
            await revalidateServerSidePath("/byok");
            setView({ mode: "list" });
            router.refresh();
        } catch {
            toast({
                variant: "danger",
                title: "Couldn't save",
                description: "Something went wrong. Try again.",
            });
        }
    };

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

    const saveAdd = async (cfg: BYOKConnectInput) => {
        const existingCred = (config?.credentials ?? []).find(
            (c) => !c.managed && c.provider === cfg.provider,
        );
        const name = displayNameFor(cfg.model);
        const blob = existingCred
            ? buildByokBlob(config, {
                kind: "add-existing-provider",
                credentialId: existingCred.id,
                model: modelFieldsFromConfig(cfg),
            })
            : buildByokBlob(config, {
                kind: "add-new-provider",
                newCredential: {
                    provider: cfg.provider,
                    apiKey: cfg.apiKey,
                    settings: credentialSettingsFromConfig(cfg),
                },
                model: modelFieldsFromConfig(cfg),
            });
        await persist(blob, `${name} added`);
    };

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
                onSave={saveAdd}
                onCancel={() => setView({ mode: "list" })}
            />
        );
    }

    // ── view: rotate a provider credential key ────────────────────────────────
    if (view.mode === "rotate") {
        const firstModel = (config?.models ?? []).find(
            (m) => m.credentialId === view.credential.id,
        );
        return (
            <RotatePanel
                credential={view.credential}
                probeModelId={firstModel?.model}
                onCancel={() => setView({ mode: "list" })}
                onSave={async (apiKey, settings) => {
                    const blob = buildByokBlob(config, {
                        kind: "rotate",
                        credentialId: view.credential.id,
                        apiKey,
                        settings,
                    });
                    await persist(blob, "Key updated");
                }}
            />
        );
    }

    // ── view: first-run ───────────────────────────────────────────────────────
    if (firstRun) {
        return <FirstRunCard existing={config} />;
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
                    onRotate={() => setView({ mode: "rotate", credential })}>
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

/**
 * Minimal credential-rotate panel — scoped to apiKey (+ optional baseURL) only,
 * per the SLICE 2 spec. Leaving the key blank keeps the stored ciphertext (the
 * blank-key keep rule); a pasted key is probed with the existing testBYOK before
 * save. The `••••` mask is NEVER seeded into the editable field.
 */
function RotatePanel({
    credential,
    probeModelId,
    onSave,
    onCancel,
}: {
    credential: BYOKCredential;
    probeModelId?: string;
    onSave: (
        apiKey: string,
        settings?: Record<string, unknown>,
    ) => Promise<void>;
    onCancel: () => void;
}) {
    const settings = (credential.settings ?? {}) as Record<string, unknown>;
    const providerLabel =
        PROVIDER_LABELS[credential.provider] ?? credential.provider;

    const [apiKey, setApiKey] = useState("");
    const [baseURL, setBaseURL] = useState(
        typeof settings.baseURL === "string" ? settings.baseURL : "",
    );
    const [isSaving, setIsSaving] = useState(false);
    const [testState, setTestState] = useState<
        { status: "idle" } | { status: "error"; result: TestBYOKResult }
    >({ status: "idle" });

    const handleSave = async () => {
        setIsSaving(true);
        try {
            // Only probe when the user typed a new key (reuse the built probe).
            if (apiKey.trim() && probeModelId) {
                const result = await testBYOK({
                    provider: credential.provider,
                    apiKey: apiKey.trim(),
                    baseURL: baseURL.trim() || undefined,
                    model: probeModelId,
                });
                if (!result.ok) {
                    setTestState({ status: "error", result });
                    return;
                }
            }
            const nextSettings: Record<string, unknown> | undefined =
                baseURL.trim()
                    ? { ...settings, baseURL: baseURL.trim() }
                    : Object.keys(settings).length > 0
                        ? settings
                        : undefined;
            await onSave(apiKey, nextSettings);
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <Alert variant="info">
                <AlertDescription className="text-pretty">
                    A key for <strong>{providerLabel}</strong> is stored (
                    <span className="font-mono">
                        {maskKey(credential.apiKey)}
                    </span>
                    ). Paste a new one to replace it — or leave blank to keep
                    the current key while you change the endpoint.
                </AlertDescription>
            </Alert>

            <FormControl.Root>
                <FormControl.Label htmlFor="rotate-key">
                    New {providerLabel} API key
                </FormControl.Label>
                <FormControl.Input>
                    <Textarea
                        id="rotate-key"
                        value={apiKey}
                        onChange={(e) => {
                            setApiKey(e.target.value);
                            if (testState.status !== "idle")
                                setTestState({ status: "idle" });
                        }}
                        className="max-h-40 min-h-24"
                        placeholder={`Paste a new ${providerLabel} API key (or leave blank to keep)`}
                    />
                </FormControl.Input>
            </FormControl.Root>

            <FormControl.Root>
                <FormControl.Label htmlFor="rotate-baseurl">
                    Base URL (optional)
                </FormControl.Label>
                <FormControl.Input>
                    <Input
                        id="rotate-baseurl"
                        value={baseURL}
                        onChange={(e) => setBaseURL(e.target.value)}
                        placeholder="https://..."
                    />
                </FormControl.Input>
            </FormControl.Root>

            {testState.status === "error" && (
                <Alert variant="danger">
                    <AlertDescription className="text-pretty">
                        {testState.result.message ??
                            "The new key failed to connect. Check it and try again."}
                    </AlertDescription>
                </Alert>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                    type="button"
                    size="md"
                    variant="cancel"
                    onClick={onCancel}>
                    Cancel
                </Button>
                <Button
                    type="button"
                    size="md"
                    variant="primary"
                    leftIcon={<PlugIcon />}
                    loading={isSaving}
                    onClick={() => void handleSave()}>
                    Save key
                </Button>
            </div>
        </div>
    );
}
