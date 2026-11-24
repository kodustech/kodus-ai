"use client";

import { useId, useMemo, useState } from "react";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { ScrollArea } from "@components/ui/scroll-area";
import { AlertTriangle, CheckCircle2, Plus, X } from "lucide-react";
import { findIgnoreMatch } from "src/core/utils/ignore-paths/match-file-against-ignore-paths";
import { checkIgnorePattern } from "src/core/utils/ignore-paths/validate-glob-pattern";

const VALIDATOR_MIN_LENGTH = 4;

/** Shared glob editor and file validator, used inline and by Ignored files. */
export function FilePatternsEditor({
    value: paths,
    onChange: setPaths,
    purpose = "ignore",
    compact = false,
    disabled = false,
    maxPatterns,
    maxPatternLength,
}: {
    value: string[];
    onChange: (paths: string[]) => void;
    purpose?: "ignore" | "include" | "exclude";
    compact?: boolean;
    disabled?: boolean;
    maxPatterns?: number;
    maxPatternLength?: number;
}) {
    const validatorId = useId();
    const [search, setSearch] = useState("");
    const [fileToTest, setFileToTest] = useState("");

    const query = search.trim();
    const newPath = query;

    const filtered = useMemo(() => {
        if (!query) return paths;

        const needle = query.toLowerCase();
        return paths.filter((path) => path.toLowerCase().includes(needle));
    }, [paths, query]);

    // Compared EXACTLY, even though the filter above compares case-insensitively.
    //
    // The two differ on purpose. The filter is a search convenience; this is a
    // question about meaning, and patterns are matched with `nocase: false`, so
    // "*.PNG" and "*.png" select different files. Treating them as one entry
    // would refuse a pattern that works — a repository holding both "logo.png"
    // and "LOGO.PNG" genuinely needs both lines.
    //
    // The cost is a small oddity: typing "YARN.LOCK" filters the existing
    // "yarn.lock" into view while still offering to add. That reads as
    // confusing and is correct; blocking a functional pattern to avoid it would
    // not be.
    const isDuplicate = newPath !== "" && paths.includes(newPath);
    const patternCheck = useMemo(
        () =>
            newPath === ""
                ? null
                : maxPatternLength !== undefined &&
                    newPath.length > maxPatternLength
                  ? {
                        valid: false,
                        message: `Use ${maxPatternLength} characters or fewer.`,
                    }
                  : checkIgnorePattern(newPath),
        [newPath, maxPatternLength],
    );
    const atLimit = maxPatterns !== undefined && paths.length >= maxPatterns;
    const canAdd = !atLimit && !isDuplicate && patternCheck?.valid === true;

    const addPath = () => {
        if (disabled || !canAdd) return;

        setPaths([...paths, newPath]);
        setSearch("");
    };

    const removePath = (pathToRemove: string) => {
        setPaths(paths.filter((path) => path !== pathToRemove));
    };

    const removeFiltered = () => {
        const doomed = new Set(filtered);
        setPaths(paths.filter((path) => !doomed.has(path)));
        setSearch("");
    };

    // Runs against the draft, so the answer reflects the edits about to be
    // applied rather than the list as it stands in the form.
    const validation = useMemo(() => {
        const file = fileToTest.trim();
        if (file.length < VALIDATOR_MIN_LENGTH) return null;

        const matchedBy = findIgnoreMatch(file, paths);
        return { ignored: Boolean(matchedBy), matchedBy };
    }, [fileToTest, paths]);

    return (
        <>
            <div className="flex flex-col gap-2">
                <div className="relative">
                    <Input
                        disabled={disabled}
                        aria-label="Add or search file patterns"
                        value={search}
                        placeholder="Search a pattern, or type a new one and press Enter to add"
                        onChange={(ev) => setSearch(ev.target.value)}
                        onKeyDown={(ev) => {
                            if (ev.key !== "Enter") return;
                            ev.preventDefault();
                            addPath();
                        }}
                    />

                    {newPath && (
                        <Button
                            type="button"
                            size="xs"
                            variant="primary-dark"
                            disabled={disabled || !canAdd}
                            className="absolute top-1/2 right-2 -translate-y-1/2"
                            leftIcon={<Plus className="size-3" />}
                            onClick={addPath}>
                            Add
                        </Button>
                    )}
                </div>

                {atLimit && (
                    <p
                        role="status"
                        className="text-text-secondary text-[13px]">
                        Limit of {maxPatterns} patterns reached. Remove one to
                        add another.
                    </p>
                )}

                {/* Deliberately "valid glob syntax", not "valid pattern".
                        A syntactically fine pattern can still match nothing —
                        no library can tell those apart, so the wording must
                        not promise more than it checked. */}
                {patternCheck &&
                    (patternCheck.valid ? (
                        <span className="text-success flex flex-row items-center gap-1.5 text-[13px]">
                            <CheckCircle2 className="size-3.5 shrink-0" />
                            Valid glob syntax
                            {isDuplicate && " — already on the list"}.
                        </span>
                    ) : (
                        <span className="text-danger flex flex-row items-center gap-1.5 text-[13px]">
                            <AlertTriangle className="size-3.5 shrink-0" />
                            {patternCheck.message}
                        </span>
                    ))}

                <div className="flex min-h-7 flex-row items-center justify-between gap-4">
                    <span className="text-text-secondary text-[13px]">
                        {query
                            ? `${filtered.length} of ${paths.length} patterns`
                            : `${paths.length} ${paths.length === 1 ? "pattern" : "patterns"}`}
                    </span>

                    {query && filtered.length > 0 && (
                        <Button
                            type="button"
                            size="sm"
                            variant="cancel"
                            disabled={disabled}
                            className="underline"
                            onClick={removeFiltered}>
                            Remove filtered ({filtered.length})
                        </Button>
                    )}
                </div>
            </div>

            <ScrollArea
                className={`border-card-lv2 rounded-lg border p-3 ${compact ? "h-32" : "h-64"}`}>
                {filtered.length === 0 ? (
                    <p className="text-text-secondary py-8 text-center text-sm">
                        No pattern matches this search.
                    </p>
                ) : (
                    <div className="flex flex-wrap gap-2">
                        {filtered.map((path) => (
                            <Button
                                type="button"
                                size="xs"
                                aria-label={`Remove ${path}`}
                                key={path}
                                variant="helper"
                                disabled={disabled}
                                onClick={() => removePath(path)}>
                                {path}
                                <X className="text-danger -mr-1 size-4" />
                            </Button>
                        ))}
                    </div>
                )}
            </ScrollArea>

            <FormControl.Root>
                <FormControl.Label htmlFor={validatorId}>
                    Test a file
                </FormControl.Label>

                <FormControl.Input>
                    <Input
                        id={validatorId}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") event.preventDefault();
                        }}
                        value={fileToTest}
                        placeholder="src/components/button.tsx"
                        onChange={(ev) => setFileToTest(ev.target.value)}
                    />
                </FormControl.Input>

                {validation ? (
                    validation.ignored ? (
                        <FormControl.Helper
                            className={`${purpose === "ignore" ? "text-danger" : "text-text-secondary"} flex flex-row items-center gap-1.5`}>
                            {purpose === "ignore" ? (
                                <X className="size-3.5 shrink-0" />
                            ) : (
                                <CheckCircle2 className="size-3.5 shrink-0" />
                            )}
                            {purpose === "ignore" ? "Ignored by" : "Matched by"}{" "}
                            <code className="font-mono">
                                {validation.matchedBy}
                            </code>
                        </FormControl.Helper>
                    ) : (
                        <FormControl.Helper className="text-success flex flex-row items-center gap-1.5">
                            <CheckCircle2 className="size-3.5 shrink-0" />
                            {purpose === "ignore"
                                ? "This file will be reviewed."
                                : "No pattern matches this file."}
                        </FormControl.Helper>
                    )
                ) : (
                    <FormControl.Helper>
                        Type at least {VALIDATOR_MIN_LENGTH} characters to check
                        a file against the list above.
                    </FormControl.Helper>
                )}
            </FormControl.Root>
        </>
    );
}
