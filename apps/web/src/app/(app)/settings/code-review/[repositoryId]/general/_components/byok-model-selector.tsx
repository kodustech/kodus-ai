"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import {
    testBYOKModel,
    type TestBYOKResult,
} from "@services/organizationParameters/fetch";
import {
    AlertTriangleIcon,
    CheckCircle2Icon,
    ChevronsUpDownIcon,
    PlusIcon,
    XCircleIcon,
} from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";
import {
    useCodeReviewConfig,
    useCodeReviewModelData,
} from "src/app/(app)/settings/_components/context";
import { useCurrentConfigLevel } from "src/app/(app)/settings/_hooks";
import { OverrideIndicator } from "src/app/(app)/settings/code-review/_components/override";
import { ArrayHelpers } from "src/core/utils/array";

import { FormattedConfigLevel, type CodeReviewFormType } from "../../../_types";

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
    const router = useRouter();
    const config = useCodeReviewConfig();
    const currentLevel = useCurrentConfigLevel();

    const { llmConfigStatus } = useCodeReviewModelData();
    const byok = llmConfigStatus?.byok;
    const provider = byok?.configured ? byok.providerId : undefined;
    const byokMainModel = byok?.model ?? "";

    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [test, setTest] = useState<
        | { status: "idle" }
        | { status: "testing" }
        | { status: "success" }
        | { status: "error"; message?: string }
    >({ status: "idle" });

    const runModelTest = async (modelId: string) => {
        if (!provider || !modelId.trim()) return;
        setTest({ status: "testing" });
        try {
            const res: TestBYOKResult = await testBYOKModel({
                provider,
                model: modelId.trim(),
            });
            setTest(
                res.ok
                    ? { status: "success" }
                    : {
                          status: "error",
                          message: res.providerMessage || res.message,
                      },
            );
        } catch (error) {
            setTest({
                status: "error",
                message:
                    error instanceof Error ? error.message : "Test failed",
            });
        }
    };

    // No main BYOK provider configured — feature hidden entirely.
    if (!provider) {
        return null;
    }

    // Only the models the org actually CONFIGURED in BYOK — not the provider's
    // full catalog. You can only route a review to a model you've set up, and
    // the id we write (`byokModelId`) must reference a real config `models[]`
    // entry so the routing resolver matches it. Mirrors the Routing tab's pool.
    const models = (llmConfigStatus?.models ?? []).map((m) => ({
        id: m.modelId,
        name: m.model ?? m.modelId,
    }));

    // The value inherited from the parent scope (repository / BYOK settings),
    // computed the same way the override indicator does. Prefer the id-based
    // override; fall back to the legacy name leaf during the compat read window.
    const leaf = config?.byokModelId ?? config?.byokModel;
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
            name="byokModelId.value"
            control={form.control}
            defaultValue={
                config?.byokModelId?.value ?? config?.byokModel?.value ?? ""
            }
            render={({ field }) => {
                const currentValue = field.value ?? "";
                const isInherited = currentValue === parentValue;
                const effectiveModelId = currentValue || byokMainModel;

                // A model id that isn't in the provider catalog — either typed
                // manually or inherited from a kodus-config.yml. We can't be
                // certain it's invalid (the catalog isn't exhaustive), so warn
                // rather than block.
                // Match by id OR name: a legacy override (or one saved before the
                // id migration) stores the model NAME, which is still a valid
                // configured model — flagging it as "unknown" would be a false
                // alarm. New picks write the stable id.
                const isUnknownModel =
                    currentValue !== "" &&
                    models.length > 0 &&
                    !models.some(
                        (m) => m.id === currentValue || m.name === currentValue,
                    );

                const selectModel = (modelId: string) => {
                    field.onChange(modelId);
                    setTest({ status: "idle" });
                    setOpen(false);
                };

                return (
                    <Card>
                        <CardHeader>
                            <div className="flex flex-row items-center gap-2">
                                <Heading variant="h3">
                                    Code review model
                                </Heading>

                                {/* Drive the badge from the SAME leaf and value
                                    the description text uses (`byokModelId ??
                                    byokModel`, plus the Controller's field
                                    value) so the two indicators can never
                                    disagree. The generic OverrideIndicatorForm
                                    read only `byokModelId` via useWatch, so a
                                    legacy `byokModel` override — or the transient
                                    post-save window before the refetch lands —
                                    made the badge vanish while the text still
                                    announced the override. */}
                                <OverrideIndicator
                                    currentValue={currentValue}
                                    initialState={
                                        leaf ?? {
                                            value: "",
                                            level: FormattedConfigLevel.DEFAULT,
                                        }
                                    }
                                    handleRevert={() =>
                                        selectModel(parentValue)
                                    }
                                />
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
                                                if (value === MANUAL_ITEM) {
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

                                                {/* Just the connected models, one
                                                    row each. Reverting to the
                                                    inherited model is the ↺ button
                                                    next to the "Overridden" badge —
                                                    no separate "inherit" row that
                                                    restates a model already listed.
                                                    Everything keys off the stable
                                                    model id; no name matching. */}
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
                                                        setOpen(false);
                                                        // A model has to be
                                                        // connected in BYOK
                                                        // before it can be
                                                        // routed here — send the
                                                        // user there instead of
                                                        // letting them type an
                                                        // id that isn't wired up.
                                                        router.push(
                                                            "/organization/byok",
                                                        );
                                                    }}>
                                                    <span className="text-primary-light flex items-center gap-1.5">
                                                        <PlusIcon className="size-3.5" />
                                                        Manage models in BYOK
                                                    </span>
                                                </CommandItem>
                                            </CommandList>
                                        </Command>
                                    </PopoverContent>
                                </Popover>

                            {isUnknownModel && (
                                <div className="border-warning/30 bg-warning/5 mt-3 rounded-lg border p-3">
                                    <div className="flex items-start gap-2">
                                        <AlertTriangleIcon className="text-warning mt-0.5 size-4 shrink-0" />
                                        <div className="flex-1">
                                            <p className="text-text-primary text-sm font-medium">
                                                This override doesn&apos;t match
                                                your current provider
                                            </p>
                                            <p className="text-text-secondary mt-1 text-xs">
                                                <code>{currentValue}</code> isn&apos;t
                                                offered by{" "}
                                                <strong>
                                                    {provider ??
                                                        "your BYOK provider"}
                                                </strong>
                                                . Reviews for this {scopeLabel}{" "}
                                                will fail or fall back until it&apos;s
                                                updated. Use{" "}
                                                <strong>Test model</strong> to
                                                verify it, or reset to inherit your
                                                BYOK main model.
                                            </p>
                                            <Button
                                                variant="tertiary"
                                                size="xs"
                                                disabled={field.disabled}
                                                className="mt-2"
                                                onClick={() =>
                                                    selectModel(parentValue)
                                                }>
                                                Reset to inherit
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {effectiveModelId && (
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                    <Button
                                        variant="helper"
                                        size="xs"
                                        disabled={
                                            field.disabled ||
                                            test.status === "testing"
                                        }
                                        loading={test.status === "testing"}
                                        onClick={() =>
                                            runModelTest(effectiveModelId)
                                        }>
                                        Test model
                                    </Button>

                                    {test.status === "success" && (
                                        <span className="text-success flex items-center gap-1 text-xs">
                                            <CheckCircle2Icon className="size-3.5" />
                                            Works on your provider
                                        </span>
                                    )}
                                    {test.status === "error" && (
                                        <span className="text-error flex items-start gap-1 text-xs">
                                            <XCircleIcon className="mt-0.5 size-3.5 shrink-0" />
                                            <span>
                                                {test.message ||
                                                    "This model failed on your provider."}
                                            </span>
                                        </span>
                                    )}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                );
            }}
        />
    );
};
