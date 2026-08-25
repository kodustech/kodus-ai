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
    useLLMProviderModelsPreview,
    useSuspenseGetLLMProviderModels,
    useSuspenseGetLLMProviders,
} from "@services/organizationParameters/hooks";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { ChevronsUpDownIcon, Loader2Icon } from "lucide-react";
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
    credentialStored = false,
}: {
    /** Model ids to hide from the dropdown — e.g. models already enabled on this
     *  provider, so "Add model" never offers a duplicate. */
    excludeIds?: string[];
    /** True when the provider already has a SAVED credential (edit / add-model to
     *  a connected provider). For a live-listing provider this lets the picker
     *  fetch the real list from the saved slot even before the user types a key. */
    credentialStored?: boolean;
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

    // Live-listing providers (e.g. OpenAI): the model list comes from a real
    // `/models` call against the typed key — no curated placeholder. Others
    // (static / curated brands) keep the keyless catalog dropdown.
    if (foundProvider?.listsModelsLive) {
        return (
            <ModelSelectLive
                excludeIds={excludeIds}
                credentialStored={credentialStored}
                onUseManual={() => setManual(true)}
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

const ModelInput = ({
    onBackToSelect,
    hint,
}: {
    onBackToSelect?: () => void;
    /** Optional helper line under the label (e.g. a live-listing fallback note). */
    hint?: string;
}) => {
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

                    {hint && (
                        <span className="text-text-tertiary mb-1 text-xs">
                            {hint}
                        </span>
                    )}

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

/**
 * Presentational model dropdown shared by the curated (keyless catalog) and live
 * (candidate-key `/models`) selectors — identical Command list, different model
 * source. Owns only the popover/search/selection; the caller supplies the models.
 */
const ModelPickerPopover = ({
    models,
    provider,
    onUseManual,
}: {
    models: Array<{ id: string; name: string }>;
    provider: string;
    onUseManual?: () => void;
}) => {
    const form = useFormContext<EditKeyForm>();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const { reset: resetErrorBoundary } = useQueryErrorResetBoundary();

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

/**
 * Curated/static dropdown: the keyless catalog served by the backend (providers
 * that ship a static list or a curated brand catalog). No key needed.
 */
const ModelSelect = ({
    onUseManual,
    excludeIds = [],
}: {
    onUseManual?: () => void;
    excludeIds?: string[];
}) => {
    const form = useFormContext<EditKeyForm>();
    const provider = form.watch("provider");
    const { models: allModels } = useSuspenseGetLLMProviderModels({ provider });

    // Hide already-enabled models (add-model never offers a duplicate). Never
    // filter out the currently-selected value, so an edit that lands on an
    // "enabled" id still renders its own label.
    const selected = form.watch("model");
    const excludeSet = new Set(excludeIds.filter((id) => id !== selected));
    const models = allModels.filter((m) => !excludeSet.has(m.id));

    return (
        <ModelPickerPopover
            models={models}
            provider={provider}
            onUseManual={onUseManual}
        />
    );
};

/** Debounce a value by `ms` — so the live model fetch fires after the user stops
 *  typing the key, not on every keystroke. */
function useDebouncedValue<T>(value: T, ms: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return debounced;
}

/**
 * Live dropdown for providers that enumerate models through a real `/models` call
 * (e.g. OpenAI). The list comes from the JUST-TYPED key — no curated placeholder.
 * Before a key exists (fresh connect) it prompts for one; a stored credential
 * (edit / add-to-connected) lists live with no typed key.
 */
const ModelSelectLive = ({
    onUseManual,
    excludeIds = [],
    credentialStored,
}: {
    onUseManual?: () => void;
    excludeIds?: string[];
    credentialStored: boolean;
}) => {
    const form = useFormContext<EditKeyForm>();
    const provider = form.watch("provider");
    const typedKeyRaw = (form.watch("apiKey") ?? "").trim();
    const typedBaseURL = (form.watch("baseURL") ?? undefined) || undefined;
    const typedKey = useDebouncedValue(typedKeyRaw, 700);
    const hasKey = typedKey.length > 0;

    // List live when we have SOMETHING to authenticate with: a typed key, or a
    // stored credential the server resolves on its own. Else prompt for the key.
    const enabled = hasKey || credentialStored;

    const { data, isFetching, isError } = useLLMProviderModelsPreview({
        provider,
        apiKey: hasKey ? typedKey : undefined,
        baseURL: typedBaseURL,
        enabled,
    });

    const selected = form.watch("model");
    const excludeSet = new Set(excludeIds.filter((id) => id !== selected));
    const models = (data ?? []).filter((m) => !excludeSet.has(m.id));

    // No credential yet — the list can't be fetched. Ask for the key; keep the
    // manual-entry escape so the user is never blocked.
    if (!enabled) {
        return (
            <FormControl.Root>
                <FormControl.Label>Model</FormControl.Label>
                <FormControl.Input>
                    <Button
                        size="md"
                        variant="helper"
                        role="combobox"
                        disabled
                        className="w-full justify-between"
                        rightIcon={
                            <ChevronsUpDownIcon className="-mr-2 opacity-50" />
                        }>
                        <span className="text-text-tertiary font-normal">
                            Enter your API key to load models
                        </span>
                    </Button>
                </FormControl.Input>
                {onUseManual && (
                    <Button
                        variant="tertiary"
                        size="xs"
                        className="mt-2"
                        onClick={onUseManual}>
                        Type model manually
                    </Button>
                )}
            </FormControl.Root>
        );
    }

    if (isFetching && models.length === 0) {
        return (
            <FormControl.Root>
                <FormControl.Label>Model</FormControl.Label>
                <FormControl.Input>
                    <Button
                        size="md"
                        variant="helper"
                        role="combobox"
                        disabled
                        className="w-full justify-between"
                        rightIcon={
                            <Loader2Icon className="-mr-2 size-4 animate-spin opacity-70" />
                        }>
                        <span className="text-text-tertiary font-normal">
                            Loading models…
                        </span>
                    </Button>
                </FormControl.Input>
                {/* Escape hatch: never trap the form on a slow/hung fetch — the
                    request is time-bounded, but the manual path stays available. */}
                {onUseManual && (
                    <Button
                        variant="tertiary"
                        size="xs"
                        className="mt-2"
                        onClick={onUseManual}>
                        Type model manually
                    </Button>
                )}
            </FormControl.Root>
        );
    }

    if (isError) {
        return (
            <ModelInput hint="Couldn't load models for that key — check it, or type the model id manually." />
        );
    }

    return (
        <ModelPickerPopover
            models={models}
            provider={provider}
            onUseManual={onUseManual}
        />
    );
};
