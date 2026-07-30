"use client";

import { Suspense, useState } from "react";
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
import { FormProvider, useForm } from "react-hook-form";
import { ConfirmModal } from "src/core/components/ui/confirm-modal";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import type { BYOKConfig } from "../_types";
import { maskKey } from "../_utils";
import { ByokAdvancedSettings } from "../_components/_modals/edit-key/_components/advanced-settings";
import { ByokBaseURLInput } from "../_components/_modals/edit-key/_components/baseurl-input";
import { ByokCredentialsInput } from "../_components/_modals/edit-key/_components/credentials-input";
import {
    ByokManualModelInput,
    ByokModelSelect,
} from "../_components/_modals/edit-key/_components/models";
import { ByokProviderSelect } from "../_components/_modals/edit-key/_components/provider";
import {
    createKeySchema,
    editKeySchema,
    type EditKeyForm,
} from "../_components/_modals/edit-key/_types";

type Slot = "main" | "fallback";

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
    slot,
    existingConfig,
    llmConfigStatus,
}: {
    slot: Slot;
    existingConfig: BYOKConfig | null;
    llmConfigStatus: LLMConfigStatus | null;
}) {
    const router = useRouter();
    const isEditing = !!existingConfig;
    const [showKeyInput, setShowKeyInput] = useState(!isEditing);
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
        resolver: zodResolver(
            isEditing ? editKeySchema : createKeySchema,
        ) as any,
        defaultValues: {
            provider: existingConfig?.provider,
            model: existingConfig?.model,
            baseURL: existingConfig?.baseURL,
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
    const awsBearerToken = form.watch("awsBearerToken");
    const awsAccessKeyId = form.watch("awsAccessKeyId");
    const awsSecretAccessKey = form.watch("awsSecretAccessKey");

    // Bedrock has no apiKey field; "creds entered" means either a bearer
    // token or the IAM access key + secret pair. Used to gate the "Test"
    // button — without this, the button stays disabled forever on Bedrock
    // because apiKey is always empty for that provider.
    const hasCredsForTest =
        provider === "amazon_bedrock"
            ? !!(
                  awsBearerToken?.trim() ||
                  (awsAccessKeyId?.trim() && awsSecretAccessKey?.trim())
              )
            : !!apiKey?.trim();

    const resetTestOnChange = () => {
        if (testState.status !== "idle") setTestState({ status: "idle" });
    };

    const runTest = async (): Promise<TestBYOKResult | null> => {
        const valid = await form.trigger();
        if (!valid) return null;

        const data = form.getValues();
        const hasNewCredentials =
            data.provider === "amazon_bedrock"
                ? !!(
                      data.awsBearerToken?.trim() ||
                      (data.awsAccessKeyId?.trim() &&
                          data.awsSecretAccessKey?.trim())
                  )
                : !!data.apiKey?.trim();

        // If the user changed the base URL on an openai_compatible config
        // without re-entering credentials, we can't skip the test: the
        // backend's SSRF guard only runs inside the test-byok probe, and
        // the new URL could point at internal infra. Forcing the probe
        // makes the backend reject with "apiKey is required", which nudges
        // the user to paste credentials to authorize the URL change.
        const urlChanged =
            (data.provider === "openai_compatible" ||
                data.provider === "anthropic_compatible") &&
            (data.baseURL ?? undefined) !== existingConfig?.baseURL;

        if (!hasNewCredentials && !urlChanged) {
            // Editing with no new credentials and no URL change: skip test
            // (stored creds and URL stay unchanged server-side).
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
        if (slot === "main" && envIsActiveSource) {
            const proceed = await confirmEnvOverride();
            if (!proceed) return;
        }

        const testResult = await runTest();
        if (!testResult?.ok) return;

        const effort = data.reasoningEffort;
        const newConfig: BYOKConfig = {
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
            openrouterProviderOrder:
                data.provider === "open_router" &&
                data.openrouterProviderOrder &&
                data.openrouterProviderOrder.length > 0
                    ? data.openrouterProviderOrder
                    : undefined,
            openrouterAllowFallbacks:
                data.provider === "open_router" &&
                typeof data.openrouterAllowFallbacks === "boolean"
                    ? data.openrouterAllowFallbacks
                    : undefined,
            vertexLocation:
                data.provider === "google_vertex" &&
                data.vertexLocation?.trim()
                    ? data.vertexLocation.trim()
                    : undefined,
            awsBearerToken:
                data.provider === "amazon_bedrock" &&
                data.awsBearerToken?.trim()
                    ? data.awsBearerToken.trim()
                    : undefined,
            awsAccessKeyId:
                data.provider === "amazon_bedrock" &&
                data.awsAccessKeyId?.trim()
                    ? data.awsAccessKeyId.trim()
                    : undefined,
            awsSecretAccessKey:
                data.provider === "amazon_bedrock" &&
                data.awsSecretAccessKey?.trim()
                    ? data.awsSecretAccessKey.trim()
                    : undefined,
            awsRegion:
                data.provider === "amazon_bedrock" && data.awsRegion?.trim()
                    ? data.awsRegion.trim()
                    : undefined,
            awsSessionToken:
                data.provider === "amazon_bedrock" &&
                data.awsSessionToken?.trim()
                    ? data.awsSessionToken.trim()
                    : undefined,
        };

        setIsSaving(true);
        try {
            await createOrUpdateOrganizationParameter(
                OrganizationParametersConfigKey.BYOK_CONFIG,
                slot === "main"
                    ? { main: newConfig }
                    : { fallback: newConfig },
            );
            toast({
                variant: "success",
                title: `${
                    slot === "main" ? "Main" : "Fallback"
                } model saved`,
            });
            await revalidateServerSidePath("/organization/byok");
            router.push("/organization/byok");
        } catch {
            toast({
                variant: "danger",
                title: `Couldn't save ${slot} model`,
                description:
                    slot === "fallback"
                        ? "A main model must be configured before a fallback can be saved."
                        : undefined,
            });
        } finally {
            setIsSaving(false);
        }
    });

    const testing = testState.status === "testing";

    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <div className="flex items-center gap-3">
                        <Link href="/organization/byok">
                            <Button
                                size="icon-xs"
                                variant="cancel"
                                aria-label="Back to BYOK">
                                <ArrowLeftIcon />
                            </Button>
                        </Link>
                        <Page.Title className="text-balance">
                            Configure {slot} model manually
                        </Page.Title>
                    </div>
                    <Page.Description className="text-pretty">
                        Pick any provider and model. Use this if your model
                        isn't in the recommended list, or if you need a custom
                        endpoint.
                    </Page.Description>
                </Page.TitleContainer>
            </Page.Header>

            <Page.Content>
                {slot === "main" && envIsActiveSource && (
                    <Alert variant="info">
                        <InfoIcon />
                        <AlertDescription className="text-pretty">
                            Kodus is currently using an LLM from environment
                            variables. Saving here will override it.
                        </AlertDescription>
                    </Alert>
                )}

                <FormProvider {...form}>
                    <QueryErrorResetBoundary>
                        {({ reset }) => (
                            <Card color="lv1">
                                <CardHeader>
                                    <h3 className="text-text-primary text-sm font-semibold text-balance">
                                        Step 1 — Provider & model
                                    </h3>
                                </CardHeader>

                                <CardContent className="flex flex-col gap-5">
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
                                                    loading providers. Please,
                                                    try again later.
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
                                                <ByokModelSelect />
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
                                    Step 2 — Credentials
                                </h3>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-4">
                                {showKeyInput ? (
                                    <ErrorBoundary
                                        resetKeys={[provider, model]}
                                        fallbackRender={() => null}>
                                        <Suspense fallback={null}>
                                            <ByokCredentialsInput />
                                        </Suspense>
                                    </ErrorBoundary>
                                ) : (
                                    <FormControl.Root>
                                        <FormControl.Label>
                                            Key
                                        </FormControl.Label>
                                        <div className="flex items-center gap-3">
                                            <span className="text-text-secondary font-mono text-sm">
                                                {maskKey(existingConfig?.apiKey)}
                                            </span>
                                            <Button
                                                type="button"
                                                variant="tertiary"
                                                size="xs"
                                                onClick={() =>
                                                    setShowKeyInput(true)
                                                }>
                                                Change key
                                            </Button>
                                        </div>
                                    </FormControl.Root>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    {provider?.trim().length > 0 && (
                        <Card color="lv1">
                            <CardHeader>
                                <h3 className="text-text-primary text-sm font-semibold text-balance">
                                    Step 3 — Advanced (optional)
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
                        <Link href="/organization/byok">
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
