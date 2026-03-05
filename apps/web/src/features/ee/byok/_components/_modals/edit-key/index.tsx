import { Suspense, useState } from "react";
import { Alert } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { magicModal } from "@components/ui/magic-modal";
import { Skeleton } from "@components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAsyncAction } from "@hooks/use-async-action";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { KeyRoundIcon, PencilIcon, SaveIcon, TrashIcon } from "lucide-react";
import { ErrorBoundary } from "react-error-boundary";
import { FormProvider, useForm } from "react-hook-form";

import curatedCatalog from "../../../_data/curated-models.json";
import type { BYOKConfig } from "../../../_types";
import { ByokAdvancedSettings } from "./_components/advanced-settings";
import { ByokBaseURLInput } from "./_components/baseurl-input";
import { GuidedModelSelection } from "./_components/guided-model-selection";
import { ByokKeyInput } from "./_components/key-input";
import { ByokManualModelInput, ByokModelSelect } from "./_components/models";
import { ByokProviderSelect } from "./_components/provider";
import { createKeySchema, editKeySchema, type EditKeyForm } from "./_types";

const curatedModelIds = new Set(curatedCatalog.models.map((m) => m.id));

export const BYOKEditKeyModal = ({
    type,
    config,
    onSave,
    onDelete,
}: {
    type: "main" | "fallback";
    config?: BYOKConfig;
    onSave: (_: BYOKConfig) => Promise<void>;
    onDelete: () => Promise<void>;
}) => {
    const isEditing = !!config;
    const [showKeyInput, setShowKeyInput] = useState(!isEditing);
    const [setupMode, setSetupMode] = useState<"curated" | "custom">(() =>
        config?.model && !curatedModelIds.has(config.model)
            ? "custom"
            : "curated",
    );

    const form = useForm<EditKeyForm>({
        mode: "onChange",
        resolver: zodResolver(isEditing ? editKeySchema : createKeySchema),
        defaultValues: {
            provider: config?.provider,
            model: config?.model,
            baseURL: config?.baseURL,
            apiKey: "",
            temperature: config?.temperature ?? null,
            maxInputTokens: config?.maxInputTokens ?? null,
            maxConcurrentRequests: config?.maxConcurrentRequests ?? null,
            maxOutputTokens: config?.maxOutputTokens ?? null,
        },
    });

    const { isValid, isSubmitting } = form.formState;

    const provider = form.watch("provider");
    const model = form.watch("model");

    const handleSubmit = form.handleSubmit(async (data) => {
        await onSave({
            ...data,
            apiKey: data.apiKey || undefined!,
            baseURL: data.baseURL || undefined,
            temperature: data.temperature ?? undefined,
            maxInputTokens: data.maxInputTokens ?? undefined,
            maxConcurrentRequests: data.maxConcurrentRequests ?? undefined,
            maxOutputTokens: data.maxOutputTokens ?? undefined,
        });
        magicModal.hide();
    });

    const [deleteKey, { loading: isDeletingKey }] = useAsyncAction(async () => {
        await onDelete();
        magicModal.hide();
    });

    return (
        <FormProvider {...form}>
            <QueryErrorResetBoundary>
                {({ reset }) => (
                    <Dialog open onOpenChange={() => magicModal.hide()}>
                        <DialogContent
                            className={
                                type === "main" ? "max-w-3xl" : "max-w-lg"
                            }>
                            <DialogHeader>
                                <DialogTitle>
                                    {!isEditing ? "Add" : "Edit"} {type} key
                                </DialogTitle>
                            </DialogHeader>

                            <div className="-mx-6 mt-4 flex max-h-[70vh] flex-col gap-6 overflow-y-auto px-6 pb-1">
                                {type === "main" ? (
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
                                            <GuidedModelSelection />
                                        </TabsContent>

                                        <TabsContent value="custom">
                                            <div className="flex flex-col gap-6">
                                                <ErrorBoundary
                                                    onReset={reset}
                                                    fallbackRender={({
                                                        resetErrorBoundary,
                                                    }) => (
                                                        <Alert
                                                            variant="danger"
                                                            className="flex items-start justify-between gap-6">
                                                            <span className="text-sm">
                                                                There was an
                                                                error when
                                                                loading
                                                                providers.
                                                                Please, try
                                                                again later.
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
                                                                setShowKeyInput(
                                                                    true,
                                                                )
                                                            }
                                                        />
                                                    </Suspense>
                                                </ErrorBoundary>

                                                {provider && (
                                                    <ErrorBoundary
                                                        onReset={reset}
                                                        resetKeys={[provider]}
                                                        fallbackRender={() =>
                                                            null
                                                        }>
                                                        <Suspense
                                                            fallback={null}>
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
                                                            <div className="flex flex-col gap-4">
                                                                <Alert
                                                                    variant="danger"
                                                                    className="flex items-start justify-between gap-6">
                                                                    <span className="text-sm">
                                                                        There
                                                                        was an
                                                                        error
                                                                        when
                                                                        loading
                                                                        models.
                                                                        You can
                                                                        still
                                                                        type a
                                                                        model
                                                                        manually
                                                                        below,
                                                                        or try
                                                                        again
                                                                        later /
                                                                        switch
                                                                        provider.
                                                                    </span>
                                                                    <Button
                                                                        variant="tertiary"
                                                                        size="xs"
                                                                        onClick={() =>
                                                                            resetErrorBoundary()
                                                                        }>
                                                                        Try
                                                                        again
                                                                    </Button>
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
                                ) : (
                                    <>
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
                                                    <div className="flex flex-col gap-4">
                                                        <Alert
                                                            variant="danger"
                                                            className="flex items-start justify-between gap-6">
                                                            <span className="text-sm">
                                                                There was an
                                                                error when
                                                                loading models.
                                                                You can still
                                                                type a model
                                                                manually below,
                                                                or try again
                                                                later / switch
                                                                provider.
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
                                    </>
                                )}

                                {model?.trim().length > 0 &&
                                    (showKeyInput ? (
                                        <ErrorBoundary
                                            onReset={reset}
                                            resetKeys={[provider, model]}
                                            fallbackRender={() => null}>
                                            <Suspense fallback={null}>
                                                <ByokKeyInput />
                                            </Suspense>
                                        </ErrorBoundary>
                                    ) : (
                                        <FormControl.Root>
                                            <FormControl.Label>
                                                Key
                                            </FormControl.Label>
                                            <div className="flex items-center gap-3">
                                                <span className="text-text-secondary flex items-center gap-2 text-sm">
                                                    <KeyRoundIcon size={14} />
                                                    {config?.apiKey}
                                                </span>
                                                <Button
                                                    type="button"
                                                    variant="tertiary"
                                                    size="xs"
                                                    leftIcon={
                                                        <PencilIcon size={12} />
                                                    }
                                                    onClick={() =>
                                                        setShowKeyInput(true)
                                                    }>
                                                    Change key
                                                </Button>
                                            </div>
                                        </FormControl.Root>
                                    ))}

                                {model?.trim().length > 0 && (
                                    <ByokAdvancedSettings />
                                )}
                            </div>

                            <DialogFooter className="justify-between">
                                <div>
                                    {isEditing && (
                                        <Button
                                            size="sm"
                                            variant="cancel"
                                            leftIcon={<TrashIcon />}
                                            loading={isDeletingKey}
                                            className="text-danger px-0 [--button-foreground:var(--color-danger)]"
                                            onClick={() => deleteKey()}>
                                            Delete
                                        </Button>
                                    )}
                                </div>

                                <Button
                                    size="md"
                                    variant="primary"
                                    leftIcon={<SaveIcon />}
                                    disabled={!isValid}
                                    loading={isSubmitting}
                                    onClick={() => handleSubmit()}>
                                    Save
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>
                )}
            </QueryErrorResetBoundary>
        </FormProvider>
    );
};
