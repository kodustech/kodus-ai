"use client";

import { useMemo, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { ScrollArea } from "@components/ui/scroll-area";
import { AlertTriangle, CheckCircle2, Plus, X } from "lucide-react";
import { findIgnoreMatch } from "src/core/utils/ignore-paths/match-file-against-ignore-paths";
import { checkIgnorePattern } from "src/core/utils/ignore-paths/validate-glob-pattern";

/** Short enough to answer fast, long enough that every list matches `**` on the
 *  first keystroke and the answer reads as noise. */
const VALIDATOR_MIN_LENGTH = 4;

type IgnorePathsModalProps = {
    initialPaths: string[];
    onCancel: () => void;
    onSave: (paths: string[]) => void;
};

/**
 * Edits a local draft; Apply hands it to the form, Cancel throws it away. The
 * draft exists for "Remove filtered", which can drop hundreds of patterns in
 * one click and would otherwise only be undoable by resetting the whole page.
 *
 * The button is "Apply", never "Save": it commits to the form, not to the
 * server. An earlier version labelled it "Save", and sitting next to the
 * page's "Save settings" that cost a user 43 removed patterns — the count
 * dropped, nothing persisted, and a reload restored the old list.
 */
export const IgnorePathsModal = ({
    initialPaths,
    onCancel,
    onSave,
}: IgnorePathsModalProps) => {
    const [paths, setPaths] = useState(initialPaths);
    const [search, setSearch] = useState("");
    const [fileToTest, setFileToTest] = useState("");

    const query = search.trim();
    const newPath = query;

    const filtered = useMemo(() => {
        if (!query) return paths;

        const needle = query.toLowerCase();
        return paths.filter((path) => path.toLowerCase().includes(needle));
    }, [paths, query]);

    const isDuplicate = newPath !== "" && paths.includes(newPath);
    const patternCheck = useMemo(
        () => (newPath === "" ? null : checkIgnorePattern(newPath)),
        [newPath],
    );
    const canAdd =
        newPath !== "" && !isDuplicate && patternCheck?.valid === true;

    const addPath = () => {
        if (!canAdd) return;

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
        <Dialog open onOpenChange={(open) => !open && onCancel()}>
            <DialogContent className="max-w-(--breakpoint-md)">
                <DialogHeader>
                    <DialogTitle>Ignored files</DialogTitle>
                    <DialogDescription>
                        Files matching any of these glob patterns are skipped by
                        the review.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-2">
                    <div className="relative">
                        <Input
                            autoFocus
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
                            <Badge
                                disabled={!canAdd}
                                className="absolute top-1/2 right-2 -translate-y-1/2"
                                leftIcon={<Plus className="size-3" />}
                                onClick={addPath}>
                                Add
                            </Badge>
                        )}
                    </div>

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
                                : `${paths.length} patterns`}
                        </span>

                        {query && filtered.length > 0 && (
                            <Button
                                size="sm"
                                variant="cancel"
                                className="underline"
                                onClick={removeFiltered}>
                                Remove filtered ({filtered.length})
                            </Button>
                        )}
                    </div>
                </div>

                <ScrollArea className="border-card-lv2 h-64 rounded-lg border-1 p-3">
                    {filtered.length === 0 ? (
                        <p className="text-text-secondary py-8 text-center text-sm">
                            No pattern matches this search.
                        </p>
                    ) : (
                        <div className="flex flex-wrap gap-2">
                            {filtered.map((path) => (
                                <Badge
                                    key={path}
                                    variant="helper"
                                    onClick={() => removePath(path)}>
                                    {path}
                                    <X className="text-danger -mr-1 size-4" />
                                </Badge>
                            ))}
                        </div>
                    )}
                </ScrollArea>

                <FormControl.Root>
                    <FormControl.Label htmlFor="ignore-paths-validator">
                        Test a file
                    </FormControl.Label>

                    <FormControl.Input>
                        <Input
                            id="ignore-paths-validator"
                            value={fileToTest}
                            placeholder="src/components/button.tsx"
                            onChange={(ev) => setFileToTest(ev.target.value)}
                        />
                    </FormControl.Input>

                    {validation ? (
                        validation.ignored ? (
                            <FormControl.Helper className="text-danger flex flex-row items-center gap-1.5">
                                <X className="size-3.5 shrink-0" />
                                Ignored by{" "}
                                <code className="font-mono">
                                    {validation.matchedBy}
                                </code>
                            </FormControl.Helper>
                        ) : (
                            <FormControl.Helper className="text-success flex flex-row items-center gap-1.5">
                                <CheckCircle2 className="size-3.5 shrink-0" />
                                This file will be reviewed.
                            </FormControl.Helper>
                        )
                    ) : (
                        <FormControl.Helper>
                            Type at least {VALIDATOR_MIN_LENGTH} characters to
                            check a file against the list above.
                        </FormControl.Helper>
                    )}
                </FormControl.Root>

                <DialogFooter className="items-center justify-between">
                    <span className="text-text-secondary text-[13px]">
                        Apply updates the field. Nothing is persisted until you
                        click{" "}
                        <strong className="font-semibold">Save settings</strong>{" "}
                        on the page.
                    </span>

                    <div className="flex flex-row gap-x-2">
                        <Button size="md" variant="cancel" onClick={onCancel}>
                            Cancel
                        </Button>

                        <Button
                            size="md"
                            variant="primary"
                            onClick={() => onSave(paths)}>
                            Apply
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
