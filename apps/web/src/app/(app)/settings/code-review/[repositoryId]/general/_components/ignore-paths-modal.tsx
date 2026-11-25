"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { toast } from "@components/ui/toaster/use-toast";

import { FilePatternsEditor } from "./file-patterns-editor";

type IgnorePathsModalProps = {
    purpose?: "ignore" | "include" | "exclude";
    initialPaths: string[];
    onCancel: () => void;
    onSave: (paths: string[]) => void;
};

/** Apply commits the draft to the form; Cancel leaves the saved field intact. */
export const IgnorePathsModal = ({
    purpose = "ignore",
    initialPaths,
    onCancel,
    onSave,
}: IgnorePathsModalProps) => {
    const [paths, setPaths] = useState(initialPaths);
    return (
        <Dialog open onOpenChange={(open) => !open && onCancel()}>
            <DialogContent className="max-w-(--breakpoint-md)">
                <DialogHeader>
                    <DialogTitle>
                        {purpose === "ignore"
                            ? "Ignored files"
                            : purpose === "include"
                              ? "Included files"
                              : "Excluded files"}
                    </DialogTitle>
                    <DialogDescription>
                        {purpose === "ignore"
                            ? "Files matching any of these glob patterns are skipped by the review."
                            : "Match file paths with glob patterns."}
                    </DialogDescription>
                </DialogHeader>
                <FilePatternsEditor
                    value={paths}
                    onChange={setPaths}
                    purpose={purpose}
                />
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

                        {/* Apply closes the modal and writes the field, and
                            nothing else on screen changes — so without this the
                            only visible result of clicking was the modal
                            disappearing, which reads as a no-op. Say what
                            happened, and say what still has to happen, since
                            the footer above is gone the moment this fires. */}
                        <Button
                            size="md"
                            variant="primary"
                            onClick={() => {
                                onSave(paths);
                                toast({
                                    variant: "info",
                                    title:
                                        purpose !== "ignore"
                                            ? "File patterns updated"
                                            : paths.length
                                              ? `${paths.length} ignored ${paths.length === 1 ? "path" : "paths"} updated`
                                              : "Ignored paths cleared",
                                    description:
                                        "Save settings to persist the change.",
                                });
                            }}>
                            Apply
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
