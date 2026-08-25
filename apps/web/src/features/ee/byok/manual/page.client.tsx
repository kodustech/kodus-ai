"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
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
    ArrowLeftIcon,
    CheckCircle2Icon,
    InfoIcon,
    PlugIcon,
    SaveIcon,
    XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ErrorBoundary } from "react-error-boundary";
import { FormProvider, useForm, useFormContext } from "react-hook-form";
import { ConfirmModal } from "src/core/components/ui/confirm-modal";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import type { BYOKConfig, BYOKConnectInput } from "../_types";
import { maskKey } from "../_utils";
import {
    buildByokBlob,
    credentialSettingsFromConfig,
    modelFieldsFromConfig,
} from "../_components/byok-write";
import {
    providerHasCredentials,
    providerOwnsField,
} from "../_components/_modals/edit-key/credential-config";
import { useCatalogModel } from "../_data/catalog-context";
import { formatModelLabel } from "../_data/model-label";
import { PROVIDER_LABELS } from "../_components/catalog/model-card";
import { VariantSelector } from "../_components/catalog/variant-selector";
import { planAccountChanged } from "./plan-account";
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
          }
        : null;

    // Endpoint currently in effect for this provider: the edited model's, or the
    // stored credential's when adding a model to a connected one. Feeds BOTH the
    // pre-filled Base URL field and the "did the user change the endpoint?" check
    // (so pre-filling the stored URL never reads as a change and wrongly forces
    // the re-auth probe).
    const currentBaseURL = existingConfig?.baseURL ?? storedBaseURL;

    // Models already enabled on this provider — hidden from the "Add model"
    // dropdown so it never offers a duplicate. The currently-edited model stays
    // visible (ByokModelSelect keeps the selected value regardless).
    const configuredModelIds = lockedProvider
        ? (existing?.models ?? [])
              .filter((m) => {
                  const cred = existing?.credentials.find(
                      (c) => c.id === m.credentialId,
                  );
                  return cred && !cred.managed && cred.provider === lockedProvider;
              })
              .map((m) => m.model)
        : [];

    const [showKeyInput, setShowKeyInput] = useState(!keyIsStored);
    const [testState, setTestState] = useState<
        | { status: "idle" }
        | { status: "testing" }
        | { status: "success"; latencyMs: number }
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
                : existingConfig?.reasoningEffort ?? null,
            reasoningConfigOverride:
                existingConfig?.reasoningConfigOverride ?? null,
            openrouterProviderOrder:
                existingConfig?.openrouterProviderOrder ?? null,
            openrouterAllowFallbacks:
                existingConfig?.openrouterAllowFallbacks ?? null,
            vertexLocation: existingConfig?.vertexLocation ?? null,
            // Sensitive Bedrock creds are stored encrypted server-side and
            // returned masked, so we can't populate the inputs from
            // existingConfig — that would re-submit the masked value and
            // corrupt the stored secret. Leaving the fields empty mirrors
            // the apiKey pattern (line 106): empty in the form means
            // "keep existing", and the user only types when changing.
            awsBearerToken: null,
            awsAccessKeyId: null,
            awsSecretAccessKey: null,
            awsRegion: existingConfig?.awsRegion ?? null,
            awsSessionToken: null,
        },
    });

    const { isValid } = form.formState;
    const provider = form.watch("provider");
    const model = form.watch("model");
    const apiKey = form.watch("apiKey");
    const watchedBaseURL = form.watch("baseURL");
    // Title label: prefer the curated displayName, else derive from the id — so
    // the header reads "Edit Kimi K2.6" / "Edit Deepseek V4 Pro", never a raw id.
    const editedCatalogModel = useCatalogModel(existingConfig?.model ?? "");
    const editLabel = existingConfig?.model
        ? (editedCatalogModel?.displayName ??
          formatModelLabel(existingConfig.model))
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
                            ? { status: "success", latencyMs: result.latencyMs }
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
                vertexLocation: data.vertexLocation ?? undefined,
                awsBearerToken: data.awsBearerToken ?? undefined,
                awsAccessKeyId: data.awsAccessKeyId ?? undefined,
                awsSecretAccessKey: data.awsSecretAccessKey ?? undefined,
                awsRegion: data.awsRegion ?? undefined,
                awsSessionToken: data.awsSessionToken ?? undefined,
            });
            if (result.ok) {
                setTestState({ status: "success", latencyMs: result.latencyMs });
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
        const existingCred = (existing?.credentials ?? []).find(
            (c) => !c.managed && c.provider === newConfig.provider,
        );
        const blob: BYOKConfig =
            isEditing && editModel
                ? buildByokBlob(existing, {
                      kind: "edit-model",
                      modelId: editModel.id,
                      model: modelFields,
                  })
                : existingCred
                  ? buildByokBlob(existing, {
                        kind: "add-existing-provider",
                        credentialId: existingCred.id,
                        model: modelFields,
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
                description: "Something went wrong. Check the model and try again.",
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
                                aria-label="Back to BYOK">
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

                                    {/* Curated brands carry connection PLANS (Z.ai
                                        Developer API vs Coding Plan — different
                                        endpoints) and a default endpoint. When the
                                        picked model is one, surface the same plan
                                        toggle + endpoint the curated panel shows;
                                        the toggle drives baseURL / concurrency. */}
                                    {provider && (
                                        <ModelPlanAndEndpoint
                                            isEditing={isEditing}
                                        />
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

/**
 * Plan (billing/endpoint variant) + endpoint for the picked model. Curated brands
 * (e.g. Z.ai) ship connection variants — "Developer API" vs "Coding Plan", each on
 * its own base URL / concurrency limit — plus a default endpoint. This mirrors the
 * curated connect panel inside the manual form so a brand's plan choice isn't lost
 * when connecting through it. The toggle writes baseURL (+ maxConcurrentRequests,
 * + a transport override if the variant declares one) straight into the form.
 * Renders nothing for a plain model with no curated endpoint.
 */
function ModelPlanAndEndpoint({ isEditing }: { isEditing: boolean }) {
    const form = useFormContext<EditKeyForm>();
    const model = form.watch("model");
    const baseURL = form.watch("baseURL");
    const curated = useCatalogModel(model);

    const variants = curated?.variants ?? [];
    const hasVariants = variants.length > 0;

    // Active plan = the one whose endpoint matches the form's current baseURL (so
    // an edit prefilled with a stored URL lands on the right toggle), else the
    // model's default variant, else the first.
    const activeVariant = useMemo(() => {
        if (!hasVariants) return undefined;
        const byUrl = baseURL
            ? variants.find((v) => v.baseURL === baseURL)
            : undefined;
        if (byUrl) return byUrl;
        const byDefault = curated?.defaultVariantId
            ? variants.find((v) => v.id === curated.defaultVariantId)
            : undefined;
        return byDefault ?? variants[0];
    }, [hasVariants, variants, baseURL, curated?.defaultVariantId]);

    // Seed the default plan's endpoint the first time a plan model is picked on a
    // FRESH add — the model dropdown selects the id but knows nothing about plans,
    // so without this the form would save with no baseURL and hit the wrong
    // endpoint. Never seed while EDITING: a legacy plan model saved with no
    // baseURL would otherwise be silently re-pointed to the default variant's
    // endpoint (and its real stored setting dropped) on the next save.
    useEffect(() => {
        if (!isEditing && hasVariants && activeVariant && !baseURL) {
            form.setValue("baseURL", activeVariant.baseURL, {
                shouldDirty: true,
            });
            if (activeVariant.maxConcurrentRequests != null) {
                form.setValue(
                    "maxConcurrentRequests",
                    activeVariant.maxConcurrentRequests,
                    { shouldDirty: true },
                );
            }
        }
    }, [isEditing, hasVariants, activeVariant, baseURL, form]);

    const applyVariant = (nextId: string) => {
        const next = variants.find((v) => v.id === nextId);
        if (!next || next.id === activeVariant?.id) return;
        form.setValue("baseURL", next.baseURL, {
            shouldValidate: true,
            shouldDirty: true,
        });
        // Plans are separate accounts — a key typed for one must not leak into the
        // other. Clear it on every switch so each plan starts from its own key
        // (or the stored key, when the plan matches the stored account).
        form.setValue("apiKey", "", { shouldValidate: true });
        form.clearErrors("apiKey");
        form.setValue(
            "maxConcurrentRequests",
            next.maxConcurrentRequests ?? null,
            { shouldDirty: true },
        );
        // A variant may speak a different transport (e.g. one plan Anthropic, one
        // OpenAI-compatible); honor it when declared, else keep the brand.
        if (next.provider) {
            form.setValue("provider", next.provider, {
                shouldValidate: true,
                shouldDirty: true,
            });
        }
    };

    const endpoint = activeVariant?.baseURL ?? curated?.defaults?.baseURL;

    if (!hasVariants && !endpoint) return null;

    return (
        <div className="flex flex-col gap-4">
            {hasVariants &&
                (isEditing ? (
                    // A plan is a SEPARATE account (its own key + endpoint) stored on
                    // the credential, so it can't be switched on an existing model.
                    // Show the current plan read-only and point at the real path:
                    // connect the provider again with the other plan's key.
                    <div className="flex flex-col gap-1.5">
                        <span className="text-text-secondary text-xs font-medium">
                            Plan
                        </span>
                        <div className="bg-card-lv2 text-text-secondary rounded-lg px-3 py-2 text-sm">
                            {activeVariant?.label ?? "—"}
                        </div>
                        <p className="text-text-tertiary text-xs text-pretty">
                            The plan is fixed for this connection — each plan is a
                            separate account with its own key and endpoint. To run
                            this model on a different plan, add the provider again
                            with that plan's key (a new connection).
                        </p>
                    </div>
                ) : (
                    <VariantSelector
                        variants={variants}
                        selectedId={activeVariant?.id}
                        docsUrl={curated?.docsUrl}
                        onSelect={applyVariant}
                    />
                ))}
            {endpoint && (
                <p className="text-text-tertiary text-xs text-pretty">
                    Endpoint:{" "}
                    <code className="bg-card-lv2 rounded px-1 py-0.5 font-mono text-[11px]">
                        {endpoint}
                    </code>
                </p>
            )}
        </div>
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
        | { status: "success"; latencyMs: number }
        | { status: "error"; result: TestBYOKResult };
}) {
    if (state.status === "idle" || state.status === "testing") return null;

    if (state.status === "success") {
        return (
            <Alert variant="success">
                <CheckCircle2Icon />
                <AlertDescription className="text-pretty">
                    Connection OK — provider responded in{" "}
                    <span className="tabular-nums">{state.latencyMs}ms</span>.
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
