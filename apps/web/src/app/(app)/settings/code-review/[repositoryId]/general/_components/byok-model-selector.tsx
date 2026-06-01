"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import {
    Command,
    CommandEmpty,
    CommandInput,
    CommandItem,
    CommandList,
} from "@components/ui/command";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { AlertTriangleIcon, ChevronsUpDownIcon } from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";
import {
    useCodeReviewConfig,
    useCodeReviewModelData,
} from "src/app/(app)/settings/_components/context";
import { useCurrentConfigLevel } from "src/app/(app)/settings/_hooks";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";
import { ArrayHelpers } from "src/core/utils/array";

import { FormattedConfigLevel, type CodeReviewFormType } from "../../../_types";

const INHERIT_ITEM = "__inherit__";
const MANUAL_ITEM = "__manual__";

/**
 * BYOK model selector for the code review General tab.
 *
 * Rendered only for repository/directory scopes that have a main BYOK provider
 * configured. The BYOK status and the provider's model catalog are both
 * server-fetched in the settings layout and read from context, so this renders
 * fully with the rest of the page — no client round-trip, no loading skeleton.
 */
export const BYOKModelSelectorSection = () => {
    const form = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();
    const currentLevel = useCurrentConfigLevel();

    const { llmConfigStatus, byokModels } = useCodeReviewModelData();
    const byok = llmConfigStatus?.byok;
    const provider = byok?.configured ? byok.providerId : undefined;
    const byokMainModel = byok?.model ?? "";

    const [open, setOpen] = useState(false);
    const [manual, setManual] = useState(false);
    const [search, setSearch] = useState("");

    // No main BYOK provider configured — feature hidden entirely.
    if (!provider) {
        return null;
    }

    const models = byokModels;

    // The value inherited from the parent scope (repository / BYOK settings),
    // computed the same way the override indicator does.
    const leaf = config?.byokModel;
    const isExistingOverride = leaf?.level === currentLevel;
    const parentValue =
        (isExistingOverride ? leaf?.overriddenValue : leaf?.value) ?? "";

    const modelName = (id: string) =>
        models.find((m) => m.id === id)?.name ?? id;

    const inheritedModelId = parentValue || byokMainModel;
    const inheritedFromBYOKSettings = !parentValue;
    const scopeLabel =
        currentLevel === FormattedConfigLevel.DIRECTORY
            ? "directory"
            : "repository";

    return (
        <Controller
            name="byokModel.value"
            control={form.control}
            defaultValue={config?.byokModel?.value ?? ""}
            render={({ field }) => {
                const currentValue = field.value ?? "";
                const isInherited = currentValue === parentValue;
                const effectiveModelId = currentValue || byokMainModel;

                // A model id that isn't in the provider catalog — either typed
                // manually or inherited from a kodus-config.yml. We can't be
                // certain it's invalid (the catalog isn't exhaustive), so warn
                // rather than block.
                const isUnknownModel =
                    currentValue !== "" &&
                    models.length > 0 &&
                    !models.some((m) => m.id === currentValue);

                const selectModel = (modelId: string) => {
                    field.onChange(modelId);
                    setOpen(false);
                };

                return (
                    <Card>
                        <CardHeader>
                            <div className="flex flex-row items-center gap-2">
                                <Heading variant="h3">
                                    Code review model
                                </Heading>

                                <OverrideIndicatorForm fieldName="byokModel" />
                            </div>

                            <p className="text-text-secondary text-sm">
                                {isInherited ? (
                                    <>
                                        Reviews run with{" "}
                                        <strong>
                                            {modelName(inheritedModelId) ||
                                                "your BYOK model"}
                                        </strong>
                                        , inherited from{" "}
                                        {inheritedFromBYOKSettings
                                            ? "BYOK settings"
                                            : "the repository"}
                                        . Pick a model to override it for this{" "}
                                        {scopeLabel}.
                                    </>
                                ) : (
                                    <>
                                        Reviews for this {scopeLabel} run with{" "}
                                        <strong>
                                            {modelName(effectiveModelId)}
                                        </strong>{" "}
                                        from your main BYOK provider.
                                    </>
                                )}
                            </p>
                        </CardHeader>

                        <CardContent className="w-full">
                            {manual ? (
                                <div className="flex flex-col gap-2">
                                    <Input
                                        size="md"
                                        id={field.name}
                                        disabled={field.disabled}
                                        value={currentValue}
                                        placeholder="Type a model id"
                                        className="w-full"
                                        onChange={(ev) =>
                                            field.onChange(ev.target.value)
                                        }
                                    />
                                    <Button
                                        variant="tertiary"
                                        size="xs"
                                        disabled={field.disabled}
                                        className="self-start"
                                        onClick={() => setManual(false)}>
                                        Select from list
                                    </Button>
                                </div>
                            ) : (
                                <Popover
                                    modal
                                    open={open}
                                    onOpenChange={setOpen}>
                                    <PopoverTrigger asChild>
                                        <Button
                                            size="lg"
                                            variant="helper"
                                            role="combobox"
                                            id={field.name}
                                            disabled={field.disabled}
                                            className="w-full justify-between"
                                            rightIcon={
                                                <ChevronsUpDownIcon className="-mr-2 opacity-50" />
                                            }>
                                            {isInherited ? (
                                                <span className="font-normal">
                                                    Inherited
                                                    {effectiveModelId
                                                        ? ` · ${modelName(effectiveModelId)}`
                                                        : ""}
                                                </span>
                                            ) : (
                                                modelName(currentValue)
                                            )}
                                        </Button>
                                    </PopoverTrigger>

                                    <PopoverContent
                                        align="start"
                                        className="w-[var(--radix-popover-trigger-width)] p-0">
                                        <Command
                                            filter={(value, search) => {
                                                if (
                                                    value === INHERIT_ITEM ||
                                                    value === MANUAL_ITEM
                                                ) {
                                                    return 1;
                                                }
                                                const model = models.find(
                                                    (m) => m.id === value,
                                                );
                                                if (!model) return 0;
                                                return model.name
                                                    .toLowerCase()
                                                    .includes(
                                                        search.toLowerCase(),
                                                    )
                                                    ? 1
                                                    : 0;
                                            }}>
                                            <CommandInput
                                                placeholder="Search models..."
                                                value={search}
                                                onValueChange={setSearch}
                                            />

                                            <CommandList className="max-h-56 overflow-y-auto p-1">
                                                <CommandEmpty>
                                                    No model found.
                                                </CommandEmpty>

                                                <CommandItem
                                                    key={INHERIT_ITEM}
                                                    value={INHERIT_ITEM}
                                                    onSelect={() =>
                                                        selectModel(parentValue)
                                                    }>
                                                    <span className="flex flex-col">
                                                        <span>
                                                            Use inherited model
                                                        </span>
                                                        {inheritedModelId && (
                                                            <span className="text-text-tertiary text-xs">
                                                                {modelName(
                                                                    inheritedModelId,
                                                                )}
                                                            </span>
                                                        )}
                                                    </span>
                                                </CommandItem>

                                                {ArrayHelpers.sortAlphabetically(
                                                    models,
                                                    "name",
                                                ).map((model) => (
                                                    <CommandItem
                                                        key={model.id}
                                                        value={model.id}
                                                        onSelect={() =>
                                                            selectModel(
                                                                model.id,
                                                            )
                                                        }>
                                                        {model.name}
                                                    </CommandItem>
                                                ))}

                                                <CommandItem
                                                    key={MANUAL_ITEM}
                                                    value={MANUAL_ITEM}
                                                    onSelect={() => {
                                                        setManual(true);
                                                        setOpen(false);
                                                    }}>
                                                    {search.trim().length
                                                        ? `Type manually: "${search.trim()}"`
                                                        : "Type model manually"}
                                                </CommandItem>
                                            </CommandList>
                                        </Command>
                                    </PopoverContent>
                                </Popover>
                            )}

                            {isUnknownModel && (
                                <p className="text-warning mt-2 flex items-start gap-1.5 text-xs">
                                    <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                                    <span>
                                        <strong>{currentValue}</strong> isn't in
                                        your BYOK provider's model list.
                                        Double-check the id — an invalid model
                                        makes reviews fail, or fall back to your
                                        BYOK fallback model.
                                    </span>
                                </p>
                            )}
                        </CardContent>
                    </Card>
                );
            }}
        />
    );
};
