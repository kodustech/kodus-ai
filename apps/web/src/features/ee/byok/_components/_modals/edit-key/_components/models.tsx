"use client";

import { useEffect, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandInput,
    CommandItem,
    CommandList,
} from "@components/ui/command";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import {
    useSuspenseGetLLMProviderModels,
    useSuspenseGetLLMProviders,
} from "@services/organizationParameters/hooks";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { ChevronsUpDownIcon } from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";
import { ArrayHelpers } from "src/core/utils/array";

import type { EditKeyForm } from "../_types";
import catalog from "../../../../_data/curated-models.json";
import {
    getAnnotationForModel,
    type CuratedModelsCatalog,
} from "../../../../_data/curated-models.types";

const annotations = (catalog as CuratedModelsCatalog).annotations;

export const ByokModelSelect = () => {
    const form = useFormContext<EditKeyForm>();
    const provider = form.watch("provider");
    const { providers } = useSuspenseGetLLMProviders();
    const foundProvider = providers.find((p) => p.id === provider);

    const [manual, setManual] = useState<boolean>(
        Boolean(foundProvider?.requiresBaseUrl),
    );

    useEffect(() => {
        // Providers that require base URL force manual input
        setManual(Boolean(foundProvider?.requiresBaseUrl));
    }, [foundProvider?.requiresBaseUrl]);

    if (manual) {
        return (
            <ModelInput
                onBackToSelect={
                    !foundProvider?.requiresBaseUrl
                        ? () => setManual(false)
                        : undefined
                }
            />
        );
    }

    return <ModelSelect onUseManual={() => setManual(true)} />;
};

// Exported lightweight manual input for external fallbacks
export const ByokManualModelInput = () => <ModelInput />;

const ModelInput = ({ onBackToSelect }: { onBackToSelect?: () => void }) => {
    const form = useFormContext<EditKeyForm>();
    const provider = form.watch("provider");
    const baseURL = form.watch("baseURL");

    return (
        <Controller
            name="model"
            control={form.control}
            render={({ field }) => (
                <FormControl.Root>
                    <FormControl.Label htmlFor={field.name}>
                        Model
                    </FormControl.Label>

                    <FormControl.Input>
                        <Input
                            {...field}
                            size="md"
                            id={field.name}
                            className="w-full justify-between"
                            placeholder="Type a model name"
                            onChange={(ev) => {
                                form.reset({
                                    model: ev.target.value,
                                    provider,
                                    apiKey: "",
                                    baseURL: baseURL,
                                });
                            }}
                        />
                    </FormControl.Input>

                    {onBackToSelect && (
                        <Button
                            variant="tertiary"
                            size="xs"
                            className="mt-2"
                            onClick={onBackToSelect}>
                            Select from list
                        </Button>
                    )}
                </FormControl.Root>
            )}
        />
    );
};

const ModelSelect = ({ onUseManual }: { onUseManual?: () => void }) => {
    const form = useFormContext<EditKeyForm>();
    const [open, setOpen] = useState(false);
    const provider = form.watch("provider");
    const { models } = useSuspenseGetLLMProviderModels({ provider });
    const { reset: resetErrorBoundary } = useQueryErrorResetBoundary();

    const { providers } = useSuspenseGetLLMProviders();
    const foundProvider = providers.find((p) => p.id === provider);
    const [search, setSearch] = useState("");

    return (
        <Popover modal open={open} onOpenChange={setOpen}>
            <Controller
                name="model"
                control={form.control}
                render={({ field }) => (
                    <FormControl.Root>
                        <FormControl.Label htmlFor={field.name}>
                            Model
                        </FormControl.Label>

                        <FormControl.Input>
                            <PopoverTrigger asChild>
                                <Button
                                    size="md"
                                    variant="helper"
                                    role="combobox"
                                    id={field.name}
                                    className="w-full justify-between"
                                    rightIcon={
                                        <ChevronsUpDownIcon className="-mr-2 opacity-50" />
                                    }>
                                    {models.find((p) => p.id === field.value)
                                        ?.name ?? (
                                        <span className="font-normal">
                                            Select a model
                                        </span>
                                    )}
                                </Button>
                            </PopoverTrigger>
                        </FormControl.Input>
                    </FormControl.Root>
                )}
            />

            <PopoverContent
                align="start"
                className="w-[var(--radix-popover-trigger-width)] p-0">
                <Command
                    filter={(value, search) => {
                        const repository = models.find((r) => r.id === value);

                        if (!repository) return 0;

                        if (
                            repository.name
                                .toLowerCase()
                                .includes(search.toLowerCase())
                        ) {
                            return 1;
                        }

                        return 0;
                    }}>
                    <CommandInput
                        placeholder="Search models..."
                        value={search}
                        onValueChange={setSearch}
                    />

                    <CommandList className="max-h-56 overflow-y-auto p-1">
                        <CommandEmpty>No model found.</CommandEmpty>

                        {ArrayHelpers.sortAlphabetically(models, "name").map(
                            (r) => {
                                const annotation = getAnnotationForModel(
                                    annotations,
                                    provider,
                                    r.id,
                                );

                                return (
                                    <CommandItem
                                        key={r.id}
                                        value={r.id}
                                        onSelect={(v) => {
                                            form.reset({
                                                model: v,
                                                provider,
                                                apiKey: "",
                                                baseURL: null,
                                            });

                                            resetErrorBoundary();
                                            setOpen(false);
                                        }}>
                                        <span className="flex items-center gap-2">
                                            {r.name}
                                            {annotation?.badge === "tested" && (
                                                <Badge
                                                    variant="success"
                                                    size="xs">
                                                    Tested
                                                </Badge>
                                            )}
                                            {annotation?.badge ===
                                                "untested" && (
                                                <span className="text-warning text-xs">
                                                    {annotation.note}
                                                </span>
                                            )}
                                            {annotation?.badge === "legacy" && (
                                                <span className="text-text-tertiary text-xs">
                                                    {annotation.note}
                                                </span>
                                            )}
                                        </span>
                                    </CommandItem>
                                );
                            },
                        )}

                        {/* Allow user to switch to manual input */}
                        <CommandItem
                            key="__manual__"
                            value="__manual__"
                            onSelect={() => {
                                onUseManual?.();
                                setOpen(false);
                            }}>
                            <span>
                                {search?.trim().length
                                    ? `Type manually: "${search.trim()}"`
                                    : "Type model manually"}
                            </span>
                        </CommandItem>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
};
