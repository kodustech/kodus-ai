// @ts-nocheck
"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { FormControl } from "@components/ui/form-control";
import { magicModal } from "@components/ui/magic-modal";
import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";
import { toast } from "@components/ui/toaster/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import {
    createOrUpdateOrganizationParameter,
    testBYOK,
    testBYOKModel,
    type LLMConfigStatus,
    type TestBYOKResult,
} from "@services/organizationParameters/fetch";
import { OrganizationParametersConfigKey } from "@services/parameters/types";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import {
    AlertTriangleIcon,
    ArrowLeftIcon,
    CheckCircle2Icon,
    InfoIcon,
    PlugIcon,
    SaveIcon,
    XCircleIcon,
} from "lucide-react";
import { ErrorBoundary } from "react-error-boundary";
import { FormProvider, useForm } from "react-hook-form";
import { ConfirmModal } from "src/core/components/ui/confirm-modal";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import { ByokAdvancedSettings } from "../_components/_modals/edit-key/_components/advanced-settings";
import { ByokBaseURLInput } from "../_components/_modals/edit-key/_components/baseurl-input";
import { ByokCredentialsInput } from "../_components/_modals/edit-key/_components/credentials-input";
import {
    ByokManualModelInput,
    ByokModelSelect,
} from "../_components/_modals/edit-key/_components/models";
import { ByokProviderSelect } from "../_components/_modals/edit-key/_components/provider";
import { ProviderDocLink } from "../_components/_modals/edit-key/_components/provider-doc-link";
import {
    createKeySchema,
    editKeySchema,
    type EditKeyForm,
} from "../_components/_modals/edit-key/_types";
import {
    providerHasCredentials,
    providerOwnsField,
    providerSettingDefaults,
    unownedStoredSettings,
} from "../_components/_modals/edit-key/credential-config";
import { SuccessClaim } from "../_components/success-claim";
import {
    buildByokBlob,
    credentialSettingsFromConfig,
    modelFieldsFromConfig,
} from "../_components/byok-write";
import { formatModelLabel } from "../_data/model-label";
import { PROVIDER_LABELS } from "../_data/provider-labels";
import type { BYOKConfig, BYOKConnectInput } from "../_types";
import { maskKey } from "../_utils";
import { planAccountChanged } from "./plan-account";

const confirmEnvOverride = (): Promise<boolean> =>
    new Promise((resolve) => {
        magicModal.show(() => (
            <ConfirmModal
                open
                title="Override env-based LLM configuration?"
                description="This will replace the LLM provider currently configured in your .env. Kodus will use the key and model you just entered instead."
                confirmText="Override env config"
                variant="primary-dark"
                onConfirm={() => {
                    resolve(true);
                    magicModal.hide();
                }}
                onCancel={() => {
                    resolve(false);
                    magicModal.hide();
                }}
            />
        ));
    });

export function ByokManualPageClient({
    existing,
    editModelId,
    presetProvider,
    llmConfigStatus,
}: {
    existing: BYOKConfig | null | undefined;
    editModelId?: string;
    presetProvider?: string;
    llmConfigStatus: LLMConfigStatus | null;
}) {
    const router = useRouter();

    // Edit mode: a ?model=<id> pointing at a connected model pre-fills the form
    // and switches the save to an in-place edit-model write (the model keeps its
    // id + credential). Absent ⇒ ADD a new model, deduping the provider key.
    const editModel = editModelId
        ? existing?.models.find((m) => m.id === editModelId)
        : undefined;
    const editCredential = editModel
        ? existing?.credentials.find((c) => c.id === editModel.credentialId)
        : undefined;
    const isEditing = !!editModel && !!editCredential;
    const editSettings = (editCredential?.settings ?? {}) as Record<
        string,
        unknown
    >;

    // A model in use by Routing (default / fallback / a per-agent override) has
    // its identity frozen: swapping the model id here would silently repoint
    // Routing. We lock only the model field — tuning stays editable — and the
    // user removes it from Routing to change the model. Routing references the
    // model ENTRY id (BYOKModelConfig.id), which is exactly editModelId.
    const routing = existing?.routing ?? {};
    const modelInUse =
        isEditing &&
        editModelId != null &&
        (routing.defaultModelId === editModelId ||
            routing.fallbackModelId === editModelId ||
            Object.values(routing.taskOverrides ?? {}).includes(editModelId));

    // The provider is FIXED when we know it up front — editing a model, or an
    // "Add a model to <provider>" (?provider=). We lock it (no re-picking, no
    // "Select a provider" placeholder, no chance to mis-pick Anthropic-compatible
    // for e.g. Moonshot) and, if that provider already has a stored key, reuse it.
    const lockedProvider = editCredential?.provider ?? presetProvider;
    const storedCred = lockedProvider
        ? existing?.credentials.find(
            (c) => !c.managed && c.provider === lockedProvider,
        )
        : undefined;
    // The endpoint the stored credential already points at — so ADDING a model
    // to a connected custom-endpoint provider shows the URL its models actually
    // hit (mirroring the reused key), instead of a blank Base URL field.
    const storedSettings = (storedCred?.settings ?? {}) as Record<
        string,
        unknown
    >;
    const storedBaseURL =
        typeof storedSettings.baseURL === "string"
            ? storedSettings.baseURL
            : undefined;
    // The key counts as "already stored" when editing, or when adding a model to
    // a provider that already has a non-managed credential.
    const keyIsStored = isEditing || !!storedCred;
    const lockedProviderLabel = lockedProvider
        ? (PROVIDER_LABELS[lockedProvider] ?? lockedProvider)
        : undefined;
    // Pre-fill (edit): the key is NEVER seeded into the editable field — the
    // credential's apiKey is a server mask; a blank form field keeps it.
    const existingConfig: BYOKConnectInput | null = isEditing
        ? {
            provider: editCredential!.provider,
            model: editModel!.model,
            apiKey: "",
            baseURL:
                typeof editSettings.baseURL === "string"
                    ? editSettings.baseURL
                    : undefined,
            temperature: editModel!.temperature,
            maxInputTokens: editModel!.maxInputTokens,
            maxOutputTokens: editModel!.maxOutputTokens,
            maxConcurrentRequests: editModel!.maxConcurrentRequests,
            reasoningEffort: editModel!.reasoningEffort,
            reasoningConfigOverride: editModel!.reasoningConfigOverride,
            vertexLocation:
                typeof editSettings.vertexLocation === "string"
                    ? editSettings.vertexLocation
                    : undefined,
            awsRegion:
                typeof editSettings.awsRegion === "string"
                    ? editSettings.awsRegion
                    : undefined,
            // OpenRouter pinning is stored under credential settings like the
            // three above, and was the only pair this lift forgot. The form
            // default reads `existingConfig?.openrouterProviderOrder ?? null`,
            // so omitting it here did two things: Edit always opened with an
            // empty field however many times the user saved, and — because
            // the backend REPLACES credential settings with what the form
            // sends (only the aws* secrets are carried over) — the next save
            // wrote settings without the key and ERASED the stored pin. The
            // value could never survive its own edit dialog.
            openrouterProviderOrder: Array.isArray(
                editSettings.openrouterProviderOrder,
            )
                ? (editSettings.openrouterProviderOrder as string[])
                : undefined,
            openrouterAllowFallbacks:
                typeof editSettings.openrouterAllowFallbacks === "boolean"
                    ? editSettings.openrouterAllowFallbacks
                    : undefined,
        }
        : null;

    // Endpoint currently in effect for this provider: the edited model's, or the
    // stored credential's when adding a model to a connected one. Feeds BOTH the
    // pre-filled Base URL field and the "did the user change the endpoint?" check
    // (so pre-filling the stored URL never reads as a change and wrongly forces
    // the re-auth probe).
    const currentBaseURL = existingConfig?.baseURL ?? storedBaseURL;

    // The provider-scoped settings the CREDENTIAL actually holds, seeded off the
    // registry rather than hand-listed here.
    //
    // Both flows through this screen write back to the same credential: editing a
    // model, and adding a model to an already-connected provider. So both have to
    // OPEN with what that credential holds — the save re-sends the form, and the
    // server replaces `settings` with what it receives, so a field that opens
    // blank is a field the save deletes.
    const currentSettings = providerSettingDefaults(
        lockedProvider,
        isEditing ? editSettings : storedSettings,
    ) as Record<string, unknown>;

    // Models already enabled on this provider — hidden from the "Add model"
    // dropdown so it never offers a duplicate. The currently-edited model stays
    // visible (ByokModelSelect keeps the selected value regardless).
    const configuredModelIds = lockedProvider
        ? (existing?.models ?? [])
            .filter((m) => {
                const cred = existing?.credentials.find(
                    (c) => c.id === m.credentialId,
                );
                return (
                    cred && !cred.managed && cred.provider === lockedProvider
                );
            })
            .map((m) => m.model)
        : [];

    const [showKeyInput, setShowKeyInput] = useState(!keyIsStored);
    const [testState, setTestState] = useState<
        | { status: "idle" }
        | { status: "testing" }
        | {
          status: "success";
          latencyMs: number;
          warning?: string;
          verifiedBy?: "catalog" | "probe";
      }
        | { status: "error"; result: TestBYOKResult }
    >({ status: "idle" });
    const [isSaving, setIsSaving] = useState(false);

    const envIsActiveSource = llmConfigStatus?.source === "env";

    const form = useForm<EditKeyForm>({
        mode: "onChange",
        // A stored key (edit OR add-to-existing-provider) uses the edit schema,
        // which allows a blank key (keep the stored ciphertext). Only a brand-new
        // provider connection must require the key up front.
        resolver: zodResolver(
            keyIsStored ? editKeySchema : createKeySchema,
        ) as any,
        defaultValues: {
            provider: existingConfig?.provider ?? lockedProvider,
            model: existingConfig?.model,
            baseURL: currentBaseURL,
            apiKey: "",
            temperature: existingConfig?.temperature ?? null,
            maxInputTokens: existingConfig?.maxInputTokens ?? null,
            maxConcurrentRequests:
                existingConfig?.maxConcurrentRequests ?? null,
            maxOutputTokens: existingConfig?.maxOutputTokens ?? null,
            reasoningEffort: existingConfig?.reasoningConfigOverride
                ? ("custom" as any)
                : (existingConfig?.reasoningEffort ?? null),
            reasoningConfigOverride:
                existingConfig?.reasoningConfigOverride ?? null,
            openrouterProviderOrder:
                (currentSettings.openrouterProviderOrder as string[]) ?? null,
            openrouterAllowFallbacks:
                (currentSettings.openrouterAllowFallbacks as boolean) ?? null,
            vertexLocation: (currentSettings.vertexLocation as string) ?? null,
            // Sensitive Bedrock creds are stored encrypted server-side and
            // returned masked, so we can't populate the inputs from
            // existingConfig — that would re-submit the masked value and
            // corrupt the stored secret. Leaving the fields empty mirrors
            // the apiKey pattern (line 106): empty in the form means
            // "keep existing", and the user only types when changing.
            awsBearerToken: null,
            awsAccessKeyId: null,
            awsSecretAccessKey: null,
            awsRegion: (currentSettings.awsRegion as string) ?? null,
            awsSessionToken: null,
        },
    });

    const { isValid } = form.formState;
    const provider = form.watch("provider");
    const model = form.watch("model");
    const apiKey = form.watch("apiKey");
    const watchedBaseURL = form.watch("baseURL");
    // Title label: derive from the id — so the header reads "Edit Kimi K2.6" /
    // "Edit Deepseek V4 Pro", never a raw id.
    const editLabel = existingConfig?.model
        ? formatModelLabel(existingConfig.model)
        : "";
    const awsBearerToken = form.watch("awsBearerToken");
    const awsAccessKeyId = form.watch("awsAccessKeyId");
    const awsSecretAccessKey = form.watch("awsSecretAccessKey");

    // A plan/variant whose endpoint is a DIFFERENT account than the stored one
    // (Kimi Developer API on api.moonshot.ai vs Kimi Code Plan on api.kimi.com —
    // separate billing, separate keys) can't reuse the stored key. Detect the
    // account switch by endpoint host and force the plan's own key to be entered.
    const planNeedsNewKey = planAccountChanged(
        isEditing,
        currentBaseURL,
        watchedBaseURL,
    );

    // Bedrock has no apiKey field; "creds entered" means either a bearer
    // token or the IAM access key + secret pair. Used to gate the "Test"
    // button — without this, the button stays disabled forever on Bedrock
    // because apiKey is always empty for that provider.
    const hasCredsForTest =
        // A stored key (edit, or add-to-existing-provider) is enough to save — the
        // save reuses it and the probe is skipped when no new key is typed. But a
        // plan switch to a different account needs a fresh key, not the stored one.
        (keyIsStored && !planNeedsNewKey) ||
        providerHasCredentials({
            provider,
            apiKey,
            awsBearerToken,
            awsAccessKeyId,
            awsSecretAccessKey,
        });

    const resetTestOnChange = () => {
        if (testState.status !== "idle") setTestState({ status: "idle" });
    };

    const runTest = async (): Promise<TestBYOKResult | null> => {
        const valid = await form.trigger();
        if (!valid) return null;

        const data = form.getValues();

        // Switched to a plan on a different account without pasting that account's
        // key — the stored key belongs to the old account and would fail auth.
        if (planNeedsNewKey && !data.apiKey.trim()) {
            form.setError("apiKey", {
                type: "manual",
                message:
                    "This plan uses a different account — paste its API key.",
            });
            return null;
        }
        const hasNewCredentials = providerHasCredentials(data);

        // If the user changed the base URL on an openai_compatible config
        // without re-entering credentials, we can't skip the test: the
        // backend's SSRF guard only runs inside the test-byok probe, and
        // the new URL could point at internal infra. Forcing the probe
        // makes the backend reject with "apiKey is required", which nudges
        // the user to paste credentials to authorize the URL change.
        const urlChanged =
            (data.provider === "openai_compatible" ||
                data.provider === "anthropic_compatible") &&
            (data.baseURL ?? undefined) !== currentBaseURL;

        if (!hasNewCredentials && !urlChanged) {
            // No NEW key typed. If a key is already stored (edit, or adding a
            // model to a connected provider), run a REAL probe with it — the
            // server resolves the stored credential — instead of faking an "ok".
            // This is the pre-refactor behavior: Test always hits the provider.
            if (keyIsStored) {
                setTestState({ status: "testing" });
                try {
                    const result = await testBYOKModel({
                        provider: data.provider,
                        model: data.model,
                    });
                    setTestState(
                        result.ok
                            ? {
                                status: "success",
                                latencyMs: result.latencyMs,
                                warning: result.warning,
                                verifiedBy: result.verifiedBy,
                            }
                            : { status: "error", result },
                    );
                    return result;
                } catch {
                    const result: TestBYOKResult = {
                        ok: false,
                        code: "unknown",
                        latencyMs: 0,
                        message: "Couldn't reach Kodus. Try again in a moment.",
                    };
                    setTestState({ status: "error", result });
                    return result;
                }
            }
            // Nothing typed and nothing stored — nothing to probe.
            return { ok: true, code: "ok", latencyMs: 0 };
        }

        setTestState({ status: "testing" });
        try {
            const result = await testBYOK({
                provider: data.provider,
                apiKey: data.apiKey,
                baseURL: data.baseURL ?? undefined,
                model: data.model,
                // Send the configured tuning so the server validates it against
                // the model's rules and exercises the real chat probe with it.
                // Same effort mapping as save: 'custom'/empty → omit (the custom
                // override isn't a plain effort); 'none' is a real "off" value.
                temperature: data.temperature ?? undefined,
                reasoningEffort:
                    data.reasoningEffort === "custom" || !data.reasoningEffort
                        ? undefined
                        : data.reasoningEffort,
                // Everything else the save will persist, so the probe runs the
                // slot being saved rather than a subset of it.
                reasoningConfigOverride:
                    data.reasoningEffort === "custom"
                        ? (data.reasoningConfigOverride ?? undefined)
                        : undefined,
                maxOutputTokens: data.maxOutputTokens ?? undefined,
                openrouterProviderOrder:
                    data.openrouterProviderOrder &&
                        data.openrouterProviderOrder.length > 0
                        ? data.openrouterProviderOrder
                        : undefined,
                openrouterAllowFallbacks:
                    typeof data.openrouterAllowFallbacks === "boolean"
                        ? data.openrouterAllowFallbacks
                        : undefined,
                vertexLocation: data.vertexLocation ?? undefined,
                awsBearerToken: data.awsBearerToken ?? undefined,
                awsAccessKeyId: data.awsAccessKeyId ?? undefined,
                awsSecretAccessKey: data.awsSecretAccessKey ?? undefined,
                awsRegion: data.awsRegion ?? undefined,
                awsSessionToken: data.awsSessionToken ?? undefined,
            });
            if (result.ok) {
                setTestState({
                    status: "success",
                    latencyMs: result.latencyMs,
                    warning: result.warning,
                    verifiedBy: result.verifiedBy,
                });
            } else {
                setTestState({ status: "error", result });
            }
            return result;
        } catch {
            const result: TestBYOKResult = {
                ok: false,
                code: "unknown",
                latencyMs: 0,
                message: "Couldn't reach Kodus. Try again in a moment.",
            };
            setTestState({ status: "error", result });
            return result;
        }
    };

    const handleTestAndSave = form.handleSubmit(async (data) => {
        // Adding the first BYOK model overrides the env-based LLM; on edit the
        // config already wins, so no confirm is needed.
        if (envIsActiveSource && !isEditing) {
            const proceed = await confirmEnvOverride();
            if (!proceed) return;
        }

        const testResult = await runTest();
        if (!testResult?.ok) return;

        const effort = data.reasoningEffort;
        const newConfig: BYOKConnectInput = {
            provider: data.provider,
            model: data.model,
            apiKey: data.apiKey || undefined!,
            baseURL: data.baseURL || undefined,
            temperature: data.temperature ?? undefined,
            maxInputTokens: data.maxInputTokens ?? undefined,
            maxConcurrentRequests: data.maxConcurrentRequests ?? undefined,
            maxOutputTokens: data.maxOutputTokens ?? undefined,
            reasoningEffort:
                effort === "custom" || !effort ? undefined : effort,
            reasoningConfigOverride:
                effort === "custom"
                    ? (data.reasoningConfigOverride ?? undefined)
                    : undefined,
            // Provider-scoped credential/settings fields: include one ONLY when
            // the active provider owns it (per the credential-config registry), so
            // a value left in RHF state after switching providers never leaks into
            // another provider's credential. Which provider owns which field lives
            // in ONE place now, not scattered as `provider === "x"` checks here.
            openrouterProviderOrder:
                providerOwnsField(data.provider, "openrouterProviderOrder") &&
                    data.openrouterProviderOrder &&
                    data.openrouterProviderOrder.length > 0
                    ? data.openrouterProviderOrder
                    : undefined,
            openrouterAllowFallbacks:
                providerOwnsField(data.provider, "openrouterAllowFallbacks") &&
                    typeof data.openrouterAllowFallbacks === "boolean"
                    ? data.openrouterAllowFallbacks
                    : undefined,
            vertexLocation:
                providerOwnsField(data.provider, "vertexLocation") &&
                    data.vertexLocation?.trim()
                    ? data.vertexLocation.trim()
                    : undefined,
            awsBearerToken:
                providerOwnsField(data.provider, "awsBearerToken") &&
                    data.awsBearerToken?.trim()
                    ? data.awsBearerToken.trim()
                    : undefined,
            awsAccessKeyId:
                providerOwnsField(data.provider, "awsAccessKeyId") &&
                    data.awsAccessKeyId?.trim()
                    ? data.awsAccessKeyId.trim()
                    : undefined,
            awsSecretAccessKey:
                providerOwnsField(data.provider, "awsSecretAccessKey") &&
                    data.awsSecretAccessKey?.trim()
                    ? data.awsSecretAccessKey.trim()
                    : undefined,
            awsRegion:
                providerOwnsField(data.provider, "awsRegion") &&
                    data.awsRegion?.trim()
                    ? data.awsRegion.trim()
                    : undefined,
            awsSessionToken:
                providerOwnsField(data.provider, "awsSessionToken") &&
                    data.awsSessionToken?.trim()
                    ? data.awsSessionToken.trim()
                    : undefined,
        };

        // Build the complete v2 blob (the ONLY accepted stored shape) by merging
        // into the existing config: edit the model in place, reuse a connected
        // provider's key, or connect a brand-new provider credential.
        const modelFields = modelFieldsFromConfig(newConfig);
        // Provider-scoped settings for an ALREADY-STORED credential. The form is
        // authoritative for the keys it renders (so clearing one really clears
        // it) and carries through the keys no form owns, because the server
        // replaces this object wholesale rather than merging it.
        const nextCredentialSettings: Record<string, unknown> = {
            ...unownedStoredSettings(isEditing ? editSettings : storedSettings),
            ...(credentialSettingsFromConfig(newConfig) ?? {}),
        };
        const existingCred = (existing?.credentials ?? []).find(
            (c) => !c.managed && c.provider === newConfig.provider,
        );
        const blob: BYOKConfig =
            isEditing && editModel
                ? buildByokBlob(existing, {
                    kind: "edit-model",
                    modelId: editModel.id,
                    model: modelFields,
                    credentialSettings: nextCredentialSettings,
                })
                : existingCred
                    ? buildByokBlob(existing, {
                        kind: "add-existing-provider",
                        credentialId: existingCred.id,
                        model: modelFields,
                        credentialSettings: nextCredentialSettings,
                    })
                    : buildByokBlob(existing, {
                        kind: "add-new-provider",
                        newCredential: {
                            provider: newConfig.provider,
                            // Bedrock carries its secret in settings (aws*), so
                            // apiKey may be empty; "" keeps the encrypt/keep path.
                            apiKey: newConfig.apiKey ?? "",
                            settings: credentialSettingsFromConfig(newConfig),
                        },
                        model: modelFields,
                    });

        setIsSaving(true);
        try {
            await createOrUpdateOrganizationParameter(
                OrganizationParametersConfigKey.BYOK_CONFIG,
                blob,
            );
            toast({
                variant: "success",
                title: `${newConfig.model} ${isEditing ? "updated" : "saved"}`,
            });
            await revalidateServerSidePath("/byok");
            router.push("/byok");
        } catch {
            toast({
                variant: "danger",
                title: `Couldn't save ${newConfig.model}`,
                description:
                    "Something went wrong. Check the model and try again.",
            });
        } finally {
            setIsSaving(false);
        }
    });

    const testing = testState.status === "testing";

    return (
        <Page.Root>
            <Page.Header className="max-w-full px-6">
                <Page.TitleContainer>
                    <div className="flex items-center gap-3">
                        <Link href="/byok">
                            <Button
                                size="icon-xs"
                                variant="cancel"
                                aria-label="Back to providers">
                                <ArrowLeftIcon />
                            </Button>
                        </Link>
                        <Page.Title className="text-balance">
                            {isEditing
                                ? `Edit ${editLabel}`
                                : lockedProviderLabel
                                    ? `Add a ${lockedProviderLabel} model`
                                    : "Configure a model manually"}
                        </Page.Title>
                    </div>
                    <Page.Description className="text-pretty">
                        {isEditing
                            ? "Update this model's endpoint or tuning. Leave the key blank to keep the stored one."
                            : lockedProviderLabel
                                ? `Type the model ID to enable${keyIsStored ? " — your key is already stored." : "."}`
                                : "Pick any provider and model. Use this if your model isn't in the recommended list, or if you need a custom endpoint."}
                    </Page.Description>
                </Page.TitleContainer>
            </Page.Header>

            <Page.Content className="max-w-full px-6">
                {envIsActiveSource && !isEditing && (
                    <Alert variant="info">
                        <InfoIcon />
                        <AlertDescription className="text-pretty">
                            Kodus is currently using an LLM from environment
                            variables. Saving here will override it.
                        </AlertDescription>
                    </Alert>
                )}

                <FormProvider {...form}>
                    {/* API key FIRST — the provider (in the title) is fixed, and a
                        provider's model list can only be fetched with the key, so
                        credentials lead, then the model. */}
                    {provider?.trim().length > 0 && (
                        <Card color="lv1">
                            <CardHeader>
                                <h3 className="text-text-primary text-sm font-semibold text-balance">
                                    API key
                                </h3>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-4">
                                {/* Show the key field when the user opened it OR the
                                    plan moved to a different account. Derived (not
                                    sticky state) so switching back to the stored
                                    account restores the "using stored key" view. */}
                                {showKeyInput || planNeedsNewKey ? (
                                    <ErrorBoundary
                                        resetKeys={[provider, model]}
                                        fallbackRender={() => null}>
                                        {planNeedsNewKey && (
                                            <p className="text-warning border-warning/30 bg-warning/10 mb-1 rounded-md border px-3 py-2 text-xs">
                                                This plan runs on a different
                                                account than your stored key —
                                                paste the key for this plan.
                                            </p>
                                        )}
                                        <Suspense fallback={null}>
                                            <ByokCredentialsInput />
                                        </Suspense>
                                    </ErrorBoundary>
                                ) : (
                                    <FormControl.Root>
                                        <FormControl.Label>
                                            Key
                                        </FormControl.Label>
                                        <span className="text-text-secondary font-mono text-sm">
                                            {maskKey(
                                                editCredential?.apiKey ??
                                                storedCred?.apiKey,
                                            )}
                                        </span>
                                        {/* The key is provider-level — changing it
                                            belongs to "Edit provider", not to
                                            adding/editing a model that reuses it. */}
                                        <FormControl.Helper>
                                            Using your stored key. Change it in{" "}
                                            <strong>Edit provider</strong>.
                                        </FormControl.Helper>
                                        {/* Provider-owned docs link (grab a key /
                                            find model ids) — present here too, not
                                            only on the key-entry path. */}
                                        <Suspense fallback={null}>
                                            <ProviderDocLink
                                                provider={lockedProvider}
                                            />
                                        </Suspense>
                                    </FormControl.Root>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    <QueryErrorResetBoundary>
                        {({ reset }) => (
                            <Card color="lv1">
                                <CardHeader>
                                    <h3 className="text-text-primary text-sm font-semibold text-balance">
                                        Model
                                    </h3>
                                </CardHeader>

                                <CardContent className="flex flex-col gap-5">
                                    {lockedProvider ? null : (
                                        <ErrorBoundary
                                            onReset={reset}
                                            fallbackRender={({
                                                resetErrorBoundary,
                                            }) => (
                                                <Alert
                                                    variant="danger"
                                                    className="flex items-start justify-between gap-6">
                                                    <span className="text-sm">
                                                        There was an error when
                                                        loading providers.
                                                        Please, try again later.
                                                    </span>
                                                    <Button
                                                        variant="tertiary"
                                                        size="xs"
                                                        onClick={() =>
                                                            resetErrorBoundary()
                                                        }>
                                                        Try again
                                                    </Button>
                                                </Alert>
                                            )}>
                                            <Suspense
                                                fallback={
                                                    <FormControl.Root>
                                                        <FormControl.Label>
                                                            Provider
                                                        </FormControl.Label>
                                                        <FormControl.Input>
                                                            <Skeleton className="h-10" />
                                                        </FormControl.Input>
                                                    </FormControl.Root>
                                                }>
                                                <ByokProviderSelect
                                                    onProviderChange={() =>
                                                        setShowKeyInput(true)
                                                    }
                                                />
                                            </Suspense>
                                        </ErrorBoundary>
                                    )}

                                    {provider && (
                                        <ErrorBoundary
                                            onReset={reset}
                                            resetKeys={[provider]}
                                            fallbackRender={() => null}>
                                            <Suspense fallback={null}>
                                                <ByokBaseURLInput />
                                            </Suspense>
                                        </ErrorBoundary>
                                    )}

                                    {provider && (
                                        <ErrorBoundary
                                            onReset={reset}
                                            resetKeys={[provider]}
                                            fallbackRender={({
                                                resetErrorBoundary,
                                            }) => (
                                                <ModelManualFallback
                                                    onRetry={resetErrorBoundary}
                                                />
                                            )}>
                                            <Suspense
                                                fallback={
                                                    <FormControl.Root>
                                                        <FormControl.Label>
                                                            Model
                                                        </FormControl.Label>
                                                        <FormControl.Input>
                                                            <Skeleton className="h-10" />
                                                        </FormControl.Input>
                                                    </FormControl.Root>
                                                }>
                                                <ByokModelSelect
                                                    excludeIds={
                                                        configuredModelIds
                                                    }
                                                    credentialStored={
                                                        keyIsStored
                                                    }
                                                    lockedInUse={modelInUse}
                                                />
                                            </Suspense>
                                        </ErrorBoundary>
                                    )}
                                </CardContent>
                            </Card>
                        )}
                    </QueryErrorResetBoundary>

                    {provider?.trim().length > 0 && (
                        <Card color="lv1">
                            <CardHeader>
                                <h3 className="text-text-primary text-sm font-semibold text-balance">
                                    Advanced (optional)
                                </h3>
                            </CardHeader>
                            <CardContent>
                                <ByokAdvancedSettings />
                            </CardContent>
                        </Card>
                    )}

                    <TestResultBanner state={testState} />

                    <div
                        className="flex flex-wrap items-center justify-end gap-2"
                        onClickCapture={resetTestOnChange}>
                        <Link href="/byok">
                            <Button type="button" size="md" variant="cancel">
                                Cancel
                            </Button>
                        </Link>
                        <Button
                            type="button"
                            size="md"
                            variant="helper"
                            leftIcon={<PlugIcon />}
                            loading={testing}
                            disabled={
                                !isValid ||
                                !hasCredsForTest ||
                                isSaving ||
                                !model?.trim()
                            }
                            onClick={() => {
                                void runTest();
                            }}>
                            Test
                        </Button>
                        <Button
                            type="button"
                            size="md"
                            variant="primary"
                            leftIcon={<SaveIcon />}
                            loading={testing || isSaving}
                            disabled={!isValid || !model?.trim()}
                            onClick={() => {
                                void handleTestAndSave();
                            }}>
                            Test &amp; save
                        </Button>
                    </div>
                </FormProvider>
            </Page.Content>
        </Page.Root>
    );
}

function ModelManualFallback({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="flex flex-col gap-2">
            <ByokManualModelInput />
            <p className="text-text-tertiary text-xs text-pretty">
                Model list isn't available for this provider right now — type
                the exact model ID above.{" "}
                <button
                    type="button"
                    onClick={onRetry}
                    className="text-primary-light hover:underline">
                    Retry loading the list
                </button>
                .
            </p>
        </div>
    );
}


function TestResultBanner({
    state,
}: {
    state:
    | { status: "idle" }
    | { status: "testing" }
    | {
          status: "success";
          latencyMs: number;
          warning?: string;
          verifiedBy?: "catalog" | "probe";
      }
    | { status: "error"; result: TestBYOKResult };
}) {
    if (state.status === "idle" || state.status === "testing") return null;

    if (state.status === "success") {
        // A pass with a warning is still a pass — the credential and the model
        // work, and the config must stay savable. What it is NOT is silent: the
        // provider ignored part of what the user pasted, and this banner used to
        // say "Connection OK" and nothing else while that happened.
        if (state.warning) {
            return (
                <Alert variant="warning">
                    <AlertTriangleIcon />
                    <AlertDescription className="flex flex-col gap-1 text-pretty">
                        <span>
                            <SuccessClaim
                                latencyMs={state.latencyMs}
                                verifiedBy={state.verifiedBy}
                            />
                        </span>
                        <span>{state.warning}</span>
                    </AlertDescription>
                </Alert>
            );
        }
        return (
            <Alert variant="success">
                <CheckCircle2Icon />
                <AlertDescription className="text-pretty">
                    <SuccessClaim
                        latencyMs={state.latencyMs}
                        verifiedBy={state.verifiedBy}
                    />
                </AlertDescription>
            </Alert>
        );
    }

    const { result } = state;
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
