"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { toast } from "@components/ui/toaster/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { createOrUpdateOrganizationParameter } from "@services/organizationParameters/fetch";
import { useSuspenseGetBYOK } from "@services/organizationParameters/hooks";
import { OrganizationParametersConfigKey } from "@services/parameters/types";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { CheckCircle2Icon, SaveIcon } from "lucide-react";
import { ErrorBoundary } from "react-error-boundary";
import { FormProvider, useForm } from "react-hook-form";
import { ByokAdvancedSettings } from "src/features/ee/byok/_components/_modals/edit-key/_components/advanced-settings";
import { ByokBaseURLInput } from "src/features/ee/byok/_components/_modals/edit-key/_components/baseurl-input";
import { GuidedModelSelection } from "src/features/ee/byok/_components/_modals/edit-key/_components/guided-model-selection";
import { ByokKeyInput } from "src/features/ee/byok/_components/_modals/edit-key/_components/key-input";
import {
    ByokManualModelInput,
    ByokModelSelect,
} from "src/features/ee/byok/_components/_modals/edit-key/_components/models";
import { ByokProviderSelect } from "src/features/ee/byok/_components/_modals/edit-key/_components/provider";
import {
    createKeySchema,
    type EditKeyForm,
} from "src/features/ee/byok/_components/_modals/edit-key/_types";
import curatedCatalog from "src/features/ee/byok/_data/curated-models.json";

import { StepIndicators } from "../_components/step-indicators";

const curatedModelIds = new Set(curatedCatalog.models.map((m) => m.id));

export const SetupByokPage = () => {
    const router = useRouter();
    const byokConfig = useSuspenseGetBYOK();

    const existingMain = byokConfig?.configValue?.main;

    const form = useForm<EditKeyForm>({
        mode: "onChange",
        resolver: zodResolver(createKeySchema),
        defaultValues: {
            provider: existingMain?.provider ?? "",
            model: existingMain?.model ?? "",
            apiKey: existingMain?.apiKey ?? "",
            baseURL: existingMain?.baseURL ?? null,
            temperature: existingMain?.temperature ?? null,
            maxInputTokens: existingMain?.maxInputTokens ?? null,
            maxConcurrentRequests: existingMain?.maxConcurrentRequests ?? null,
            maxOutputTokens: existingMain?.maxOutputTokens ?? null,
        },
    });

    useEffect(() => {
        form.reset({
            provider: existingMain?.provider ?? "",
            model: existingMain?.model ?? "",
            apiKey: existingMain?.apiKey ?? "",
            baseURL: existingMain?.baseURL ?? null,
            temperature: existingMain?.temperature ?? null,
            maxInputTokens: existingMain?.maxInputTokens ?? null,
            maxConcurrentRequests: existingMain?.maxConcurrentRequests ?? null,
            maxOutputTokens: existingMain?.maxOutputTokens ?? null,
        });
        void form.trigger();
    }, [
        existingMain?.apiKey,
        existingMain?.baseURL,
        existingMain?.model,
        existingMain?.provider,
        existingMain?.temperature,
        existingMain?.maxInputTokens,
        existingMain?.maxConcurrentRequests,
        existingMain?.maxOutputTokens,
        form,
    ]);

    const [setupMode, setSetupMode] = useState<"curated" | "custom">(() =>
        existingMain?.model && !curatedModelIds.has(existingMain.model)
            ? "custom"
            : "curated",
    );

    const { isSubmitting, isValid } = form.formState;
    const provider = form.watch("provider");
    const model = form.watch("model");

    const handleSubmit = form.handleSubmit(async (values) => {
        try {
            await createOrUpdateOrganizationParameter(
                OrganizationParametersConfigKey.BYOK_CONFIG,
                {
                    main: {
                        ...values,
                        baseURL: values.baseURL || undefined,
                        temperature: values.temperature ?? undefined,
                        maxInputTokens: values.maxInputTokens ?? undefined,
                        maxConcurrentRequests:
                            values.maxConcurrentRequests ?? undefined,
                        maxOutputTokens: values.maxOutputTokens ?? undefined,
                    },
                },
            );

            toast({
                variant: "success",
                title: "BYOK saved",
                description: "Your key is set. You can update it anytime.",
            });

            router.replace("/setup/choosing-repositories");
        } catch (error) {
            console.error("Error saving BYOK during setup", error);
            toast({
                variant: "danger",
                title: "We couldn't save your key",
                description: "Check your credentials and try again.",
            });
        }
    });

    return (
        <Page.Root className="mx-auto flex h-[calc(100vh-4rem)] w-full flex-row overflow-hidden p-6">
            <div className="bg-card-lv1 flex flex-10 flex-col justify-center gap-10 rounded-3xl p-12">
                <div className="flex flex-1 flex-col justify-center gap-8">
                    <Heading variant="h1" className="max-w-80 text-[4vh]">
                        Self-hosted runs with your own AI key
                    </Heading>

                    <div className="flex flex-col gap-3">
                        <div className="bg-card-lv2 flex items-center gap-4 rounded-2xl border px-6 py-4 text-sm">
                            <span className="text-primary bg-primary/10 flex h-8 w-8 items-center justify-center rounded-full">
                                <CheckCircle2Icon size={18} />
                            </span>
                            <div>
                                <p className="text-sm font-semibold">
                                    Full control of provider and spend
                                </p>
                                <p className="text-text-secondary text-xs">
                                    Pick any supported LLM, adjust limits
                                    anytime.
                                </p>
                            </div>
                        </div>

                        <div className="bg-card-lv2 flex items-center gap-4 rounded-2xl border px-6 py-4 text-sm">
                            <span className="text-primary bg-primary/10 flex h-8 w-8 items-center justify-center rounded-full">
                                <CheckCircle2Icon size={18} />
                            </span>
                            <div>
                                <p className="text-sm font-semibold">
                                    Keys stay in your environment
                                </p>
                                <p className="text-text-secondary text-xs">
                                    We only store what is needed to run reviews
                                    from your install.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex flex-14 flex-col items-center gap-10 overflow-y-auto p-10">
                <div className="flex w-full max-w-118 flex-col gap-8">
                    <StepIndicators.Auto />

                    <div className="flex flex-col gap-2">
                        <Heading variant="h2">Add your AI provider</Heading>
                        <p className="text-text-secondary text-sm">
                            Self-hosted installs need your own key to run pull
                            request reviews. You can change this later in
                            Settings.
                        </p>
                    </div>

                    <FormProvider {...form}>
                        <QueryErrorResetBoundary>
                            {({ reset }) => (
                                <div className="flex flex-col gap-6">
                                    <Tabs
                                        value={setupMode}
                                        onValueChange={(v) =>
                                            setSetupMode(
                                                v as "curated" | "custom",
                                            )
                                        }>
                                        <TabsList>
                                            <TabsTrigger value="curated">
                                                Curated
                                            </TabsTrigger>
                                            <TabsTrigger value="custom">
                                                Custom
                                            </TabsTrigger>
                                        </TabsList>

                                        <TabsContent value="curated">
                                            <GuidedModelSelection
                                                collapseOnSelect
                                            />
                                        </TabsContent>

                                        <TabsContent value="custom">
                                            <div className="flex flex-col gap-6">
                                                <ErrorBoundary
                                                    onReset={reset}
                                                    fallbackRender={({
                                                        resetErrorBoundary,
                                                    }) => (
                                                        <Alert variant="danger">
                                                            <div className="flex flex-col gap-2">
                                                                <p className="text-sm">
                                                                    There was an
                                                                    error
                                                                    loading
                                                                    providers.
                                                                </p>
                                                                <div>
                                                                    <Button
                                                                        variant="tertiary"
                                                                        size="xs"
                                                                        onClick={() =>
                                                                            resetErrorBoundary()
                                                                        }>
                                                                        Try
                                                                        again
                                                                    </Button>
                                                                </div>
                                                            </div>
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
                                                        <ByokProviderSelect />
                                                    </Suspense>
                                                </ErrorBoundary>

                                                {provider && (
                                                    <ByokBaseURLInput />
                                                )}

                                                {provider && (
                                                    <ErrorBoundary
                                                        onReset={reset}
                                                        resetKeys={[provider]}
                                                        fallbackRender={({
                                                            resetErrorBoundary,
                                                        }) => (
                                                            <div className="flex flex-col gap-4">
                                                                <Alert variant="danger">
                                                                    <div className="flex flex-col gap-2">
                                                                        <p className="text-sm">
                                                                            There
                                                                            was
                                                                            an
                                                                            error
                                                                            loading
                                                                            models.
                                                                        </p>
                                                                        <div>
                                                                            <Button
                                                                                variant="tertiary"
                                                                                size="xs"
                                                                                onClick={() =>
                                                                                    resetErrorBoundary()
                                                                                }>
                                                                                Try
                                                                                again
                                                                            </Button>
                                                                        </div>
                                                                    </div>
                                                                </Alert>

                                                                <ByokManualModelInput />
                                                            </div>
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
                                            </div>
                                        </TabsContent>
                                    </Tabs>

                                    {model?.trim().length > 0 && (
                                        <div>
                                            <ByokKeyInput />
                                            <p className="text-text-secondary mt-2 text-xs">
                                                Your AI provider may charge for
                                                usage.
                                            </p>
                                        </div>
                                    )}

                                    {model?.trim().length > 0 && (
                                        <ByokAdvancedSettings />
                                    )}
                                </div>
                            )}
                        </QueryErrorResetBoundary>
                    </FormProvider>

                    <div className="mt-2 flex w-full flex-col gap-2">
                        <div className="flex w-full items-center justify-end">
                            <Button
                                size="lg"
                                className="w-full"
                                variant="primary"
                                leftIcon={<SaveIcon />}
                                disabled={!isValid}
                                loading={isSubmitting}
                                onClick={() => handleSubmit()}>
                                Continue with BYOK
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Page.Root>
    );
};
