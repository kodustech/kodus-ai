"use client";

import React, { useCallback, useMemo } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { getTextStatsFromTiptapJSON } from "@components/ui/rich-text-editor";
import {
    RichTextEditorWithMentions,
    type MentionGroup,
    type MentionGroupItem,
} from "@components/ui/rich-text-editor-with-mentions";
import {
    ControllerRenderProps,
    Path,
    useController,
    useFormContext,
} from "react-hook-form";

import {
    getPromptFieldText,
    parsePromptFieldValue,
    serializePromptFieldValue,
} from "../_utils/custom-prompts-state";
import { OverrideIndicatorForm } from "../../../_components/override";
import { type CodeReviewFormType } from "../../../_types";
import { ExternalReferencesDisplay } from "../../pr-summary/_components/external-references-display";

type PromptEditorFieldProps = {
    name: Path<CodeReviewFormType>;
    fieldName: string;
    label: string;
    helperText: string;
    placeholder: string;
    defaultValue: string;
    canEdit: boolean;
    groups: MentionGroup[];
    formatInsertByType: Partial<
        Record<string, (item: MentionGroupItem) => string>
    >;
};

const buildStats = (value: string | object) => {
    if (typeof value === "object" && value !== null) {
        return getTextStatsFromTiptapJSON(value);
    }

    return {
        characters: value?.length || 0,
        words: 0,
        mentions: 0,
    };
};

function PromptEditorFieldComponent({
    name,
    fieldName,
    label,
    helperText,
    placeholder,
    defaultValue,
    canEdit,
    groups,
    formatInsertByType,
}: PromptEditorFieldProps) {
    const form = useFormContext<CodeReviewFormType>();
    const { field } = useController({
        control: form.control,
        name,
    });

    const parsedValue = useMemo(
        () => parsePromptFieldValue(field.value),
        [field.value],
    );
    const currentText = useMemo(
        () => getPromptFieldText(parsedValue),
        [parsedValue],
    );
    const defaultText = useMemo(
        () => getPromptFieldText(defaultValue),
        [defaultValue],
    );
    const isDefault = currentText === defaultText;
    const stats = useMemo(() => buildStats(parsedValue), [parsedValue]);
    const externalReferences = form.getValues(
        fieldName as any,
    )?.externalReferences;

    const handleChange = useCallback(
        (value: string | object) => {
            field.onChange(serializePromptFieldValue(value));
        },
        [field],
    );

    return (
        <FormControl.Root>
            <div className="flex items-center justify-between gap-3">
                <div className="mb-2 flex flex-row items-center gap-2">
                    <FormControl.Label className="mb-0" htmlFor={name}>
                        {label}
                    </FormControl.Label>
                    <OverrideIndicatorForm fieldName={fieldName} />
                </div>

                <div className="flex items-center gap-2">
                    <Badge
                        variant="secondary"
                        className="h-6 min-h-auto px-2.5">
                        {isDefault ? "Default" : "Custom"}
                    </Badge>
                    <Button
                        data-reset-button
                        size="sm"
                        variant="helper"
                        onClick={() => field.onChange(defaultValue)}
                        disabled={!canEdit || isDefault}>
                        Reset to default
                    </Button>
                </div>
            </div>

            <FormControl.Helper className="mb-3">
                {helperText}
            </FormControl.Helper>
            <FormControl.Input>
                <div>
                    <RichTextEditorWithMentions
                        value={parsedValue}
                        onChangeAction={handleChange}
                        placeholder={placeholder}
                        className="min-h-32"
                        disabled={!canEdit || field.disabled}
                        groups={groups}
                        formatInsertByType={formatInsertByType}
                    />
                    <FormControl.Helper className="text-text-secondary mt-2 block text-right text-xs">
                        <span className="font-medium">{stats.characters}</span>{" "}
                        chars
                        {stats.words > 0 && (
                            <>
                                {" "}
                                ·{" "}
                                <span className="font-medium">
                                    {stats.words}
                                </span>{" "}
                                words
                            </>
                        )}
                        {stats.mentions > 0 && (
                            <>
                                {" "}
                                ·{" "}
                                <span className="font-medium">
                                    {stats.mentions}
                                </span>{" "}
                                mentions
                            </>
                        )}
                        {" / 2000"}
                    </FormControl.Helper>
                    <ExternalReferencesDisplay
                        externalReferences={externalReferences}
                        compact
                    />
                </div>
            </FormControl.Input>
        </FormControl.Root>
    );
}

export const PromptEditorField = React.memo(PromptEditorFieldComponent);
