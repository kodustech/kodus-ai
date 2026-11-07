"use client";

import { useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Pencil, X } from "lucide-react";

import { IgnorePathsModal } from "./ignore-paths-modal";

/** The existing ignore-path editor, with labels for condition file filters. */
export function FilePatternsField({
    label,
    value,
    onChange,
    disabled,
    purpose,
    hint,
}: {
    label: string;
    value: string[];
    onChange: (paths: string[]) => void;
    disabled?: boolean;
    purpose: "include" | "exclude";
    hint?: string;
}) {
    const [editing, setEditing] = useState(false);
    return (
        <FormControl.Root>
            <FormControl.Label>{label}</FormControl.Label>
            <div className="flex flex-wrap items-center gap-2">
                {value.slice(0, 4).map((path) => (
                    <Badge
                        key={path}
                        variant="helper"
                        disabled={disabled}
                        onClick={() =>
                            onChange(value.filter((item) => item !== path))
                        }>
                        {path}
                        <X className="text-danger -mr-1 size-4" />
                    </Badge>
                ))}
                {value.length > 4 && (
                    <Badge
                        variant="helper"
                        disabled={disabled}
                        onClick={() => setEditing(true)}>
                        +{value.length - 4} more
                    </Badge>
                )}
                <Button
                    type="button"
                    size="sm"
                    variant="cancel"
                    disabled={disabled}
                    onClick={() => setEditing(true)}
                    aria-label={`Edit ${label.toLowerCase()}`}
                    leftIcon={<Pencil className="size-3.5" />}>
                    Edit
                </Button>
            </div>
            {hint && <FormControl.Helper>{hint}</FormControl.Helper>}
            {editing && (
                <IgnorePathsModal
                    purpose={purpose}
                    initialPaths={value}
                    onCancel={() => setEditing(false)}
                    onSave={(paths) => {
                        onChange(paths);
                        setEditing(false);
                    }}
                />
            )}
        </FormControl.Root>
    );
}
