"use client";

import { useId, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    MAX_FILE_PATTERN_LENGTH,
    MAX_FILE_PATTERNS,
} from "@libs/common/utils/glob-pattern-validation";

import { FilePatternsEditor } from "./file-patterns-editor";

/** File filters stay in their parent form; the same glob validator is shared. */
export function FilePatternsField({
    label,
    value,
    onChange,
    disabled,
    purpose,
    hint,
    emptyLabel,
}: {
    label: string;
    value: string[];
    onChange: (paths: string[]) => void;
    disabled?: boolean;
    purpose: "include" | "exclude";
    hint?: string;
    emptyLabel?: string;
}) {
    const id = useId();
    const [editing, setEditing] = useState(false);
    return (
        <section aria-labelledby={id} className="space-y-3">
            <div className="flex items-center justify-between gap-3">
                <h4 id={id} className="text-text-primary text-sm font-medium">
                    {label}
                </h4>
                <Button
                    type="button"
                    size="sm"
                    variant="helper"
                    disabled={disabled}
                    aria-label={
                        editing
                            ? `Close ${label.toLowerCase()} editor`
                            : `Edit ${label.toLowerCase()}`
                    }
                    aria-expanded={editing}
                    onClick={() => setEditing(!editing)}>
                    {editing
                        ? "Done"
                        : value.length
                          ? "Edit files"
                          : "Add files"}
                </Button>
            </div>
            {hint && (
                <p className="text-text-secondary text-sm leading-6">{hint}</p>
            )}
            {editing ? (
                <div className="border-card-lv3 space-y-3 rounded-lg border p-4">
                    <FilePatternsEditor
                        value={value}
                        onChange={onChange}
                        purpose={purpose}
                        compact
                        maxPatterns={MAX_FILE_PATTERNS}
                        maxPatternLength={MAX_FILE_PATTERN_LENGTH}
                        disabled={disabled}
                    />
                </div>
            ) : value.length ? (
                <div className="flex flex-wrap gap-2">
                    {value.slice(0, 4).map((path) => (
                        <Badge key={path} variant="helper">
                            <code className="break-all">{path}</code>
                        </Badge>
                    ))}
                    {value.length > 4 && (
                        <span className="text-text-secondary text-sm">
                            +{value.length - 4} more
                        </span>
                    )}
                </div>
            ) : (
                <p className="text-text-secondary text-sm">
                    {emptyLabel ??
                        (purpose === "include" ? "All files" : "No exclusions")}
                </p>
            )}
        </section>
    );
}
