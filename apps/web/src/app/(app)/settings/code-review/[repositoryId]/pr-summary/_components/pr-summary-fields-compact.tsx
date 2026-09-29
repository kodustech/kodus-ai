"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { FormControl } from "@components/ui/form-control";
import { magicModal } from "@components/ui/magic-modal";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { Switch } from "@components/ui/switch";
import { Textarea } from "@components/ui/textarea";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { EyeIcon, PlusIcon } from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";

import { OverrideIndicatorForm } from "../../../_components/override";
import { PRSummaryPreviewModal } from "../../../_components/pr-summary-preview-modal/modal";
import {
    CodeReviewSummaryOptions,
    type CodeReviewFormType,
} from "../../../_types";
import { useCodeReviewConfig } from "../../../../_components/context";
import { useCodeReviewRouteParams } from "../../../../_hooks";
import { ExternalReferencesDisplay } from "./external-references-display";
import {
    behaviorForCommitsAfterPROpenedOptions,
    examples,
    reviewOptions,
} from "./pr-summary-fields";

/**
 * The same PR-summary fields as the full page, at reading density: the two
 * behaviour choices are selects side by side (the chosen option's
 * description sits under each), the examples are a line of chips, and the
 * instructions box is shorter. Used by the Output tab, where this is one
 * of three things on the screen.
 */
/**
 * Runs the summary settings against a real pull request (the existing
 * preview modal). Standalone so a host can place it in the section header,
 * next to the title it acts on.
 */
export const PrSummaryPreviewButton = () => {
    const config = useCodeReviewConfig();
    const { repositoryId } = useCodeReviewRouteParams();
    const form = useFormContext<CodeReviewFormType>();
    const canReadPrs = usePermission(Action.Read, ResourceType.PullRequests);
    const generatePRSummary = form.watch("summary.generatePRSummary.value");

    return (
        <Button
            size="sm"
            variant="helper"
            leftIcon={<EyeIcon />}
            disabled={!generatePRSummary || !canReadPrs}
            onClick={() => {
                const behaviourForExistingDescription = form.getValues(
                    "summary.behaviourForExistingDescription.value",
                );
                const customInstructions = form.getValues(
                    "summary.customInstructions.value",
                );
                magicModal.show(() => (
                    <PRSummaryPreviewModal
                        repositoryId={repositoryId}
                        customInstructions={customInstructions!}
                        repositoryName={config?.name ?? ""}
                        behaviourForExistingDescription={
                            behaviourForExistingDescription!
                        }
                    />
                ));
            }}>
            Try on a real PR
        </Button>
    );
};

export const PrSummaryFieldsCompact = ({
    showPreviewButton = true,
}: {
    showPreviewButton?: boolean;
} = {}) => {
    const config = useCodeReviewConfig();
    const form = useFormContext<CodeReviewFormType>();
    const generatePRSummary = form.watch("summary.generatePRSummary.value");
    const [isExternalReferencesProcessing, setIsExternalReferencesProcessing] =
        useState(false);

    return (
        <div className="flex flex-col gap-6">
            <div data-field-name="summary.generatePRSummary.value">
                <Controller
                    name="summary.generatePRSummary.value"
                    control={form.control}
                    render={({ field }) => (
                        <Button
                            size="sm"
                            variant="helper"
                            disabled={field.disabled}
                            onClick={() => field.onChange(!field.value)}
                            className="w-full">
                            <CardHeader className="flex flex-row items-center justify-between p-4">
                                <div className="flex flex-row items-center gap-2">
                                    <FormControl.Label className="mb-0">
                                        Write a summary on every pull request
                                    </FormControl.Label>
                                    <OverrideIndicatorForm fieldName="summary.generatePRSummary" />
                                </div>
                                <Switch
                                    size="sm"
                                    decorative
                                    checked={field.value}
                                />
                            </CardHeader>
                        </Button>
                    )}
                />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
                <div data-field-name="summary.behaviourForExistingDescription.value">
                    <Controller
                        name="summary.behaviourForExistingDescription.value"
                        control={form.control}
                        render={({ field }) => {
                            const selected = reviewOptions.find(
                                (option) => option.value === field.value,
                            );
                            return (
                                <FormControl.Root>
                                    <div className="mb-1 flex flex-row items-center gap-2">
                                        <FormControl.Label className="mb-0">
                                            When the PR already has a
                                            description
                                        </FormControl.Label>
                                        <OverrideIndicatorForm fieldName="summary.behaviourForExistingDescription" />
                                    </div>
                                    <FormControl.Input>
                                        <Select
                                            value={field.value}
                                            disabled={
                                                field.disabled ||
                                                !generatePRSummary
                                            }
                                            onValueChange={(value) => {
                                                if (!value) return;
                                                field.onChange(
                                                    value as CodeReviewSummaryOptions,
                                                );
                                            }}>
                                            <SelectTrigger>
                                                <SelectValue placeholder="Choose…" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {reviewOptions.map((option) => (
                                                    <SelectItem
                                                        key={option.value}
                                                        value={option.value}>
                                                        {option.name}
                                                        {"default" in option
                                                            ? " (default)"
                                                            : ""}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </FormControl.Input>
                                    {selected && (
                                        <FormControl.Helper>
                                            {selected.description}
                                        </FormControl.Helper>
                                    )}
                                </FormControl.Root>
                            );
                        }}
                    />
                </div>

                <div data-field-name="summary.behaviourForNewCommits.value">
                    <Controller
                        name="summary.behaviourForNewCommits.value"
                        control={form.control}
                        render={({ field }) => {
                            const selected =
                                behaviorForCommitsAfterPROpenedOptions.find(
                                    (option) => option.value === field.value,
                                );
                            return (
                                <FormControl.Root>
                                    <div className="mb-1 flex flex-row items-center gap-2">
                                        <FormControl.Label className="mb-0">
                                            When new commits arrive
                                        </FormControl.Label>
                                        <OverrideIndicatorForm fieldName="summary.behaviourForNewCommits" />
                                    </div>
                                    <FormControl.Input>
                                        <Select
                                            value={field.value}
                                            disabled={
                                                field.disabled ||
                                                !generatePRSummary
                                            }
                                            onValueChange={(value) => {
                                                if (!value) return;
                                                field.onChange(value);
                                            }}>
                                            <SelectTrigger>
                                                <SelectValue placeholder="Choose…" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {behaviorForCommitsAfterPROpenedOptions.map(
                                                    (option) => (
                                                        <SelectItem
                                                            key={option.value}
                                                            value={
                                                                option.value
                                                            }>
                                                            {option.name}
                                                            {"default" in option
                                                                ? " (default)"
                                                                : ""}
                                                        </SelectItem>
                                                    ),
                                                )}
                                            </SelectContent>
                                        </Select>
                                    </FormControl.Input>
                                    {selected && (
                                        <FormControl.Helper>
                                            {selected.description}
                                        </FormControl.Helper>
                                    )}
                                </FormControl.Root>
                            );
                        }}
                    />
                </div>
            </div>

            <div data-field-name="summary.customInstructions.value">
                <Controller
                    name="summary.customInstructions.value"
                    control={form.control}
                    render={({ field }) => (
                        <FormControl.Root>
                            <div className="mb-1 flex flex-row items-center gap-2">
                                <FormControl.Label
                                    className="mb-0"
                                    htmlFor={field.name}>
                                    Summary instructions
                                </FormControl.Label>
                                <OverrideIndicatorForm fieldName="summary.customInstructions" />
                            </div>
                            <FormControl.Helper className="mb-2">
                                Optional. What the summary should focus on or
                                leave out.
                            </FormControl.Helper>
                            <FormControl.Input>
                                <Textarea
                                    value={field.value}
                                    disabled={
                                        field.disabled ||
                                        !generatePRSummary ||
                                        isExternalReferencesProcessing
                                    }
                                    id={field.name}
                                    className="min-h-28"
                                    placeholder="Write the instructions here"
                                    onChange={(e) =>
                                        field.onChange(e.target.value)
                                    }
                                />
                                <ExternalReferencesDisplay
                                    externalReferences={
                                        (
                                            config?.summary
                                                ?.customInstructions as any
                                        )?.externalReferences
                                    }
                                    onProcessingChange={
                                        setIsExternalReferencesProcessing
                                    }
                                    compact
                                />
                            </FormControl.Input>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                <span className="text-text-tertiary text-xs">
                                    Examples
                                </span>
                                {examples.map((example) => (
                                    <Button
                                        key={example}
                                        size="xs"
                                        variant="helper"
                                        leftIcon={<PlusIcon />}
                                        disabled={!generatePRSummary}
                                        onClick={() =>
                                            field.onChange(
                                                field.value
                                                    ? `${field.value}\n${example}`
                                                    : example,
                                            )
                                        }>
                                        {example}
                                    </Button>
                                ))}
                            </div>
                        </FormControl.Root>
                    )}
                />
            </div>

            {showPreviewButton && (
                <div className="-mt-2 flex justify-end">
                    <PrSummaryPreviewButton />
                </div>
            )}
        </div>
    );
};
