"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { FormControl } from "@components/ui/form-control";
import { Textarea } from "@components/ui/textarea";
import { toast } from "@components/ui/toaster/use-toast";
import {
    createOrUpdateOrganizationParameter,
    testBYOK,
    type TestBYOKResult,
} from "@services/organizationParameters/fetch";
import { OrganizationParametersConfigKey } from "@services/parameters/types";
import {
    CheckCircle2Icon,
    LockIcon,
    PlugIcon,
    XCircleIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import curatedCatalog from "../_data/curated-models.json";
import type { CuratedModel } from "../_data/curated-models.types";
import type { BYOKConfig, BYOKConfigV2 } from "../_types";
import {
    buildV2Blob,
    credentialSettingsFromConfig,
    modelFieldsFromConfig,
} from "./byok-v2-write";
import { CuratedCatalog } from "./catalog/catalog";
import { CuratedModelCard, PROVIDER_LABELS } from "./catalog/model-card";

const TRUST_LINE =
    "Encrypted at rest. Sent only to your provider — Kodus never stores or sees it in plaintext.";

/** The single recommended model: highest benchmarkScore among tier "recommended". */
const pickRecommended = (): CuratedModel | undefined =>
    [...(curatedCatalog.models as CuratedModel[])]
        .filter((m) => m.tier === "recommended")
        .sort((a, b) => b.benchmarkScore - a.benchmarkScore)[0];

/**
 * D-UI-FIRSTRUN "1 decision" card. A no-model org sees ONE curated pick (the
 * top-scored recommended model) pre-selected, a key field + [Connect] — no
 * routing/budget. "Choose a different model" expands the existing CuratedCatalog
 * verbatim. Every write goes through buildV2Blob (blank-key keep rule) → the
 * untyped create-or-update endpoint, with routing.defaultModelId → the new model.
 */
export function FirstRunCard({
    existing,
}: {
    existing: BYOKConfigV2 | null | undefined;
}) {
    const router = useRouter();
    const recommended = pickRecommended();

    const [showCatalog, setShowCatalog] = useState(false);
    const [apiKey, setApiKey] = useState("");
    const [isSaving, setIsSaving] = useState(false);
    const [testState, setTestState] = useState<
        | { status: "idle" }
        | { status: "testing" }
        | { status: "error"; result: TestBYOKResult }
    >({ status: "idle" });

    const persist = async (blob: BYOKConfigV2, modelName: string) => {
        await createOrUpdateOrganizationParameter(
            OrganizationParametersConfigKey.BYOK_CONFIG,
            blob,
        );
        toast({
            variant: "success",
            title: `Connected — ${modelName} is now your default for every task.`,
        });
        await revalidateServerSidePath("/organization/byok");
        router.refresh();
    };

    /** Adapter for the catalog path: convert its legacy BYOKConfig into a v2 blob. */
    const saveFromCatalog = async (cfg: BYOKConfig) => {
        const blob = buildV2Blob(existing, {
            kind: "connect",
            newCredential: {
                provider: cfg.provider,
                apiKey: cfg.apiKey,
                settings: credentialSettingsFromConfig(cfg),
            },
            model: modelFieldsFromConfig(cfg),
        });
        const name =
            (curatedCatalog.models as CuratedModel[]).find(
                (m) => m.id === cfg.model,
            )?.displayName ?? cfg.model;
        await persist(blob, name);
    };

    const handleConnect = async () => {
        if (!recommended || !apiKey.trim()) return;

        setTestState({ status: "testing" });
        let result: TestBYOKResult;
        try {
            result = await testBYOK({
                provider: recommended.provider,
                apiKey: apiKey.trim(),
                baseURL: recommended.defaults.baseURL,
                model: recommended.id,
            });
        } catch {
            result = {
                ok: false,
                code: "unknown",
                latencyMs: 0,
                message: "Couldn't reach Kodus. Try again in a moment.",
            };
        }

        if (!result.ok) {
            setTestState({ status: "error", result });
            return;
        }

        setTestState({ status: "idle" });
        setIsSaving(true);
        try {
            const blob = buildV2Blob(existing, {
                kind: "connect",
                newCredential: {
                    provider: recommended.provider,
                    apiKey: apiKey.trim(),
                    settings: recommended.defaults.baseURL
                        ? { baseURL: recommended.defaults.baseURL }
                        : undefined,
                },
                model: {
                    model: recommended.id,
                    reasoningEffort: recommended.defaults.reasoningEffort,
                    temperature: recommended.defaults.temperature,
                    maxOutputTokens: recommended.defaults.maxOutputTokens,
                },
            });
            await persist(blob, recommended.displayName);
        } catch {
            toast({
                variant: "danger",
                title: "Couldn't connect the model",
                description: "Something went wrong saving your key. Try again.",
            });
        } finally {
            setIsSaving(false);
        }
    };

    if (showCatalog) {
        return (
            <CuratedCatalog
                slot="main"
                existingKeyByProvider={{}}
                onSave={saveFromCatalog}
                onCancel={() => setShowCatalog(false)}
            />
        );
    }

    if (!recommended) {
        // Defensive: no curated recommended model in the catalog. Fall back to
        // the full catalog rather than a dead card.
        return (
            <CuratedCatalog slot="main" onSave={saveFromCatalog} />
        );
    }

    const providerLabel =
        recommended.providerDisplayName ??
        PROVIDER_LABELS[recommended.provider] ??
        recommended.provider;
    const testing = testState.status === "testing";

    return (
        <Card color="lv1" className="ring-primary-light/40 ring-1">
            <CardHeader>
                <h3 className="text-text-primary text-base font-semibold text-balance">
                    Recommended for code review
                </h3>
                <p className="text-text-secondary text-sm text-pretty">
                    Pick a model, paste your key, and every review, PR summary,
                    and conversation uses it — until you tell Kodus otherwise.
                </p>
            </CardHeader>

            <CardContent className="flex flex-col gap-5">
                <CuratedModelCard model={recommended} isSelected />

                <FormControl.Root>
                    <FormControl.Label htmlFor="first-run-key">
                        {providerLabel} API key
                    </FormControl.Label>
                    <FormControl.Input>
                        <Textarea
                            id="first-run-key"
                            value={apiKey}
                            onChange={(e) => {
                                setApiKey(e.target.value);
                                if (testState.status !== "idle")
                                    setTestState({ status: "idle" });
                            }}
                            className="max-h-40 min-h-24"
                            placeholder={`Paste your ${providerLabel} API key`}
                        />
                    </FormControl.Input>
                    <FormControl.Helper>
                        <span className="text-text-tertiary flex items-center gap-1.5">
                            <LockIcon size={12} />
                            {TRUST_LINE}
                        </span>
                    </FormControl.Helper>
                </FormControl.Root>

                {testState.status === "error" && (
                    <TestErrorBanner result={testState.result} />
                )}

                <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                        type="button"
                        size="md"
                        variant="cancel"
                        onClick={() => setShowCatalog(true)}>
                        Choose a different model
                    </Button>
                    <Button
                        type="button"
                        size="md"
                        variant="primary"
                        leftIcon={<PlugIcon />}
                        loading={testing || isSaving}
                        disabled={!apiKey.trim() || testing || isSaving}
                        onClick={() => void handleConnect()}>
                        Connect
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}

function TestErrorBanner({ result }: { result: TestBYOKResult }) {
    const headline = (() => {
        switch (result.code) {
            case "auth":
                return "Invalid API key";
            case "not_found":
                return "Endpoint not found";
            case "bad_request":
                return "Request rejected by provider";
            case "payment":
                return "Insufficient balance or inactive billing";
            case "rate_limit":
                return "Rate limited";
            case "server_error":
                return "Provider is having issues";
            case "network":
                return "Couldn't reach the provider";
            default:
                return "Connection failed";
        }
    })();

    return (
        <Alert variant="danger">
            <XCircleIcon />
            <AlertDescription className="flex flex-col gap-2 text-pretty">
                <span className="text-text-primary font-semibold">
                    {headline}
                    {result.httpStatus ? (
                        <span className="text-text-secondary ml-2 font-normal tabular-nums">
                            · HTTP {result.httpStatus}
                        </span>
                    ) : null}
                </span>
                {result.message && <span>{result.message}</span>}
                {result.providerMessage && (
                    <span className="bg-card-lv2 text-text-secondary block rounded-md px-2.5 py-1.5 font-mono text-xs break-words">
                        <span className="text-text-tertiary mr-1">
                            Provider said:
                        </span>
                        {result.providerMessage}
                    </span>
                )}
            </AlertDescription>
        </Alert>
    );
}
