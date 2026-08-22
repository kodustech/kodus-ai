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
import {
    getAnnotationForModel,
    type CuratedModelsCatalog,
} from "../../../../_data/curated-models.types";

// Annotations (per-model badges) are not part of the backend catalog and are
// currently empty — default to none. Re-add via the catalog endpoint if needed.
const annotations: CuratedModelsCatalog["annotations"] = {};

export const ByokModelSelect = ({
    excludeIds = [],
}: {
    /** Model ids to hide from the dropdown — e.g. models already enabled on this
     *  provider, so "Add model" never offers a duplicate. */
    excludeIds?: string[];
} = {}) => {
    const form = useFormContext<EditKeyForm>();
    const provider = form.watch("provider");
    const { providers } = useSuspenseGetLLMProviders();
    const foundProvider = providers.find((p) => p.id === provider);

    // Force manual model entry only when the provider's models can't be
    // auto-listed (custom endpoint whose URL isn't known yet, or a `manual`
    // listing) — driven by the registry, so a provider with a real listing +
    // default base URL (e.g. Moonshot) shows the dropdown instead.
    const [manual, setManual] = useState<boolean>(
        !(foundProvider?.autoListModels ?? false),
    );

    useEffect(() => {
        setManual(!(foundProvider?.autoListModels ?? false));
    }, [foundProvider?.autoListModels]);

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

    return (
        <ModelSelect
            excludeIds={excludeIds}
            onUseManual={() => setManual(true)}
        />
    );
};

// Exported lightweight manual input for external fallbacks
export const ByokManualModelInput = () => <ModelInput />;

const ModelInput = ({ onBackToSelect }: { onBackToSelect?: () => void }) => {
    const form = useFormContext<EditKeyForm>();

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
                            // Controlled from first render: the RHF field starts
                            // undefined for a fresh add, which would flip the input
                            // uncontrolled→controlled on first keystroke.
                            value={field.value ?? ""}
                            size="md"
                            id={field.name}
                            className="w-full justify-between"
                            placeholder="Type a model name"
                            onChange={field.onChange}
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

const ModelSelect = ({
    onUseManual,
    excludeIds = [],
}: {
    onUseManual?: () => void;
    excludeIds?: string[];
}) => {
    const form = useFormContext<EditKeyForm>();
    const [open, setOpen] = useState(false);
    const provider = form.watch("provider");
    const { models: allModels } = useSuspenseGetLLMProviderModels({ provider });
    const { reset: resetErrorBoundary } = useQueryErrorResetBoundary();

    // Hide already-enabled models (add-model never offers a duplicate). Never
    // filter out the currently-selected value, so an edit that lands on an
    // "enabled" id still renders its own label.
    const selected = form.watch("model");
    const excludeSet = new Set(excludeIds.filter((id) => id !== selected));
    const models = allModels.filter((m) => !excludeSet.has(m.id));

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
                                                ...form.getValues(),
                                                model: v,
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
