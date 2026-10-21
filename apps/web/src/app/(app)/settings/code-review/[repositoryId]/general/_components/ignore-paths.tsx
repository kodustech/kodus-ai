"use client";

import { useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Pencil, X } from "lucide-react";
import { useController, useFormContext } from "react-hook-form";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";

import type { CodeReviewFormType } from "../../../_types";
import { IgnorePathsModal } from "./ignore-paths-modal";

const PREVIEW_LIMIT = 4;

export const IgnorePaths = () => {
    const form = useFormContext<CodeReviewFormType>();
    const { field } = useController({
        name: "ignorePaths.value",
        control: form.control,
    });
    const [isEditing, setIsEditing] = useState(false);

    const paths: string[] = Array.isArray(field.value) ? field.value : [];
    const preview = paths.slice(0, PREVIEW_LIMIT);
    const hiddenCount = paths.length - preview.length;

    const openModal = () => {
        if (field.disabled) return;
        setIsEditing(true);
    };

    return (
        <FormControl.Root>
            <div className="mb-2 flex flex-row items-center gap-2">
                {/* No htmlFor: the field is a tag list plus a button, not a
                    single labelable control. Pointing the label at the button
                    made "Ignored files" its accessible name instead of
                    "Edit". */}
                <FormControl.Label>Ignored files</FormControl.Label>

                <OverrideIndicatorForm fieldName="ignorePaths" />
            </div>

            <FormControl.Input>
                <div className="flex flex-wrap items-center gap-2">
                    {preview.map((path) => (
                        <Badge
                            key={path}
                            variant="helper"
                            disabled={field.disabled}
                            onClick={() =>
                                field.onChange(
                                    paths.filter((item) => item !== path),
                                )
                            }>
                            {path}
                            <X className="text-danger -mr-1 size-4" />
                        </Badge>
                    ))}

                    {hiddenCount > 0 && (
                        <Badge
                            variant="helper"
                            disabled={field.disabled}
                            onClick={openModal}>
                            +{hiddenCount} more
                        </Badge>
                    )}

                    <Button
                        size="sm"
                        variant="cancel"
                        disabled={field.disabled}
                        leftIcon={<Pencil className="size-3.5" />}
                        onClick={openModal}>
                        Edit
                    </Button>
                </div>
            </FormControl.Input>

            <FormControl.Helper>
                Glob pattern for file path. Example: **/*.js
            </FormControl.Helper>

            {isEditing && (
                <IgnorePathsModal
                    initialPaths={paths}
                    onCancel={() => setIsEditing(false)}
                    onSave={(nextPaths) => {
                        field.onChange(nextPaths);
                        setIsEditing(false);
                    }}
                />
            )}
        </FormControl.Root>
    );
};
