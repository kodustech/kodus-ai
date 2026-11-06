"use client";

import { useEffect, useState } from "react";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { Label } from "@components/ui/label";
import { magicModal } from "@components/ui/magic-modal";
import { useAsyncAction } from "@hooks/use-async-action";
import {
    previewRepositorySelection,
    type RepositorySelectionPreview,
} from "@services/codeManagement/repositorySelection";

const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;

export const EnableReviewAllModal = ({
    teamId,
    platformName,
    initialIncludeForksAndMirrors,
    onConfirm,
}: {
    teamId: string;
    platformName: string;
    initialIncludeForksAndMirrors: boolean;
    onConfirm: (includeForksAndMirrors: boolean) => Promise<void>;
}) => {
    const [includeForksAndMirrors, setIncludeForksAndMirrors] = useState(
        initialIncludeForksAndMirrors,
    );
    const [result, setResult] = useState<{
        includeForksAndMirrors: boolean;
        preview?: RepositorySelectionPreview;
        error?: string;
    }>();

    useEffect(() => {
        let cancelled = false;

        previewRepositorySelection(teamId, includeForksAndMirrors)
            .then((preview) => {
                if (!cancelled) setResult({ includeForksAndMirrors, preview });
            })
            .catch(() => {
                if (!cancelled)
                    setResult({
                        includeForksAndMirrors,
                        error: `Could not list the repositories on ${platformName}. Check the integration and try again.`,
                    });
            });

        return () => {
            cancelled = true;
        };
    }, [teamId, includeForksAndMirrors, platformName]);

    // Only the answer for the current checkbox state counts.
    const current =
        result?.includeForksAndMirrors === includeForksAndMirrors
            ? result
            : undefined;
    const preview = current?.preview;
    const previewError = current?.error;

    const [confirm, { loading }] = useAsyncAction(async () => {
        magicModal.lock();
        try {
            await onConfirm(includeForksAndMirrors);
        } finally {
            magicModal.hide();
        }
    });

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent className="w-lg">
                <DialogHeader>
                    <DialogTitle>Review every repository?</DialogTitle>
                </DialogHeader>

                <div className="space-y-3 text-sm">
                    <p>
                        Kody will review pull requests on every repository this{" "}
                        {platformName} integration can see, including
                        repositories created later. New repositories are set up
                        within about 10 minutes.
                    </p>

                    {previewError ? (
                        <p className="text-danger">{previewError}</p>
                    ) : !preview ? (
                        <p className="text-text-secondary">
                            Counting repositories…
                        </p>
                    ) : (
                        <div className="bg-card-lv2 rounded-lg p-3">
                            <p className="text-text-primary font-medium">
                                This enables review on{" "}
                                {plural(
                                    preview.toAdd,
                                    "more repository",
                                    "more repositories",
                                )}
                                {preview.alreadySelected > 0 &&
                                    ` (${preview.alreadySelected} already reviewed)`}
                                .
                            </p>
                            <p className="text-text-secondary mt-1">
                                Skipped:{" "}
                                {plural(
                                    preview.skipped.archived,
                                    "archived repository",
                                    "archived repositories",
                                )}
                                {!includeForksAndMirrors &&
                                    `, ${plural(
                                        preview.skipped.forksAndMirrors,
                                        "fork or mirror",
                                        "forks and mirrors",
                                    )}`}
                                .
                            </p>
                            <p className="text-text-secondary mt-1">
                                Reviews on these repositories use credits (or
                                your own model key) and may take license seats
                                for their pull request authors.
                            </p>
                        </div>
                    )}

                    <div className="flex items-center gap-2">
                        <Checkbox
                            id="include-forks-and-mirrors"
                            checked={includeForksAndMirrors}
                            onCheckedChange={(checked) =>
                                setIncludeForksAndMirrors(Boolean(checked))
                            }
                        />
                        <Label htmlFor="include-forks-and-mirrors">
                            Also review forks and mirrors
                        </Label>
                    </div>

                    <p className="text-text-secondary">
                        To leave a repository out, turn off automated review in
                        its code review settings.
                    </p>
                </div>

                <DialogFooter>
                    <Button
                        size="md"
                        variant="cancel"
                        onClick={() => magicModal.hide()}>
                        Cancel
                    </Button>
                    <Button
                        size="md"
                        variant="primary"
                        loading={loading}
                        disabled={!preview}
                        onClick={confirm}>
                        Review every repository
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
