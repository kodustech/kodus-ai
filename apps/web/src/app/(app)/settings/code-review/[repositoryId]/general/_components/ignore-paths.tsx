"use client";

import { useEffect, useMemo, useState } from "react";
import { FormControl } from "@components/ui/form-control";
import { Textarea } from "@components/ui/textarea";
import { useController, useFormContext } from "react-hook-form";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";

import type { CodeReviewFormType } from "../../../_types";

export const IgnorePaths = () => {
    const form = useFormContext<CodeReviewFormType>();
    const { field } = useController({
        name: "ignorePaths.value",
        control: form.control,
    });
    const fieldValue = useMemo(
        () => (Array.isArray(field.value) ? field.value.join("\n") : ""),
        [field.value],
    );
    const [draftValue, setDraftValue] = useState(fieldValue);
    const [isEditing, setIsEditing] = useState(false);

    useEffect(() => {
        if (!isEditing && draftValue !== fieldValue) {
            setDraftValue(fieldValue);
        }
    }, [isEditing, draftValue, fieldValue]);

    return (
        <FormControl.Root>
            <div className="mb-2 flex flex-row items-center gap-2">
                <FormControl.Label htmlFor={field.name}>
                    Ignored files
                </FormControl.Label>

                <OverrideIndicatorForm fieldName="ignorePaths" />
            </div>

            <FormControl.Input>
                <Textarea
                    id={field.name}
                    disabled={field.disabled}
                    value={draftValue}
                    onFocus={() => setIsEditing(true)}
                    onChange={(ev) => {
                        const nextValue = ev.target.value;
                        setDraftValue(nextValue);
                        const ignorePaths = nextValue
                            .split("\n")
                            .map((item) => item.trim())
                            .filter((item) => item !== "");

                        field.onChange(ignorePaths);
                    }}
                    onBlur={() => {
                        setIsEditing(false);
                        field.onBlur();
                    }}
                    placeholder={`List the files to be ignored here, one per line. Example:\n\nyarn.lock\npackage-lock.json\npackage.json\n.env`}
                    maxLength={1000}
                    className="min-h-40"
                />
            </FormControl.Input>

            <FormControl.Helper>
                Glob pattern for file path. One per line. Example: **/*.js
            </FormControl.Helper>
        </FormControl.Root>
    );
};
