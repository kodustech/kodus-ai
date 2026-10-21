"use client";

import { Suspense, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { magicModal } from "@components/ui/magic-modal";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import {
    Tooltip,
    TooltipContent,
    TooltipPortal,
    TooltipProvider,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { PARAMETERS_PATHS } from "@services/parameters";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import {
    isCentralizedPrResponse,
    ParametersConfigKey,
} from "@services/parameters/types";
import { FolderPlusIcon, InfoIcon, XIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { GitDirectorySelector } from "../code-review/_components/git-directory-selector";
import { getCentralizedPrToastPayload } from "../code-review/_utils/centralized-pr-feedback";

export const DirectoryScopeModal = ({
    repository,
    editGroup,
}: {
    repository: { id: string; name: string };
    editGroup?: { id: string; initialPaths: string[] };
}) => {
    const { teamId } = useSelectedTeamId();
    const { invalidateQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();
    const [directoryPaths, setDirectoryPaths] = useState<string[]>(
        editGroup?.initialPaths ?? [],
    );
    const [isSubmitting, setIsSubmitting] = useState(false);
    const validPaths = directoryPaths.filter((path) => path !== "/");

    const handleSubmit = async () => {
        if (validPaths.length === 0) return;

        magicModal.lock();
        setIsSubmitting(true);

        try {
            const result = await createOrUpdateCodeReviewParameter(
                {},
                teamId,
                repository.id,
                editGroup?.id,
                validPaths,
            );
            if ((result as { error?: unknown })?.error) {
                throw new Error("Could not save directory scope");
            }

            await Promise.all([
                invalidateQueries({
                    queryKey: generateQueryKey(
                        PARAMETERS_PATHS.CODE_REVIEW_SCOPES,
                        { params: { teamId } },
                    ),
                }),
                invalidateQueries({
                    queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                        params: {
                            key: ParametersConfigKey.CODE_REVIEW_CONFIG,
                            teamId,
                        },
                    }),
                }),
                invalidateQueries({
                    queryKey: generateQueryKey(
                        PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
                        { params: { teamId } },
                    ),
                }),
            ]);

            if (isCentralizedPrResponse(result)) {
                toast(
                    getCentralizedPrToastPayload(
                        result,
                        "Directory scope changes proposed through centralized pull request.",
                    ),
                );
            }
            magicModal.hide(true);
        } catch {
            toast({
                title: "Could not save directory scope",
                description: "Please try again.",
                variant: "danger",
            });
        } finally {
            magicModal.unlock();
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent
                className="max-w-5xl"
                onOpenAutoFocus={(event) => event.preventDefault()}>
                <DialogHeader>
                    <DialogTitle>
                        {editGroup
                            ? "Edit directory scope"
                            : "Add directory scope"}
                    </DialogTitle>
                    <DialogDescription>
                        Choose directories in {repository.name} that should
                        share review settings.
                    </DialogDescription>
                </DialogHeader>

                <FormControl.Root>
                    <FormControl.Label>Select directories</FormControl.Label>
                    <FormControl.Input>
                        <div className="flex gap-4">
                            <Card className="min-w-0 flex-1 ring-1">
                                <Suspense
                                    fallback={
                                        <CardHeader className="flex-row items-center gap-5 py-4 text-sm">
                                            <Spinner className="size-6" />
                                            <span className="text-text-secondary">
                                                Loading directories
                                            </span>
                                        </CardHeader>
                                    }>
                                    <CardHeader className="max-h-[28rem] overflow-y-auto py-4">
                                        <GitDirectorySelector
                                            multiple
                                            value={directoryPaths}
                                            repositoryId={repository.id}
                                            excludeGroupId={editGroup?.id}
                                            onValueChange={setDirectoryPaths}
                                        />
                                    </CardHeader>
                                </Suspense>
                            </Card>
                            <Card className="w-80 shrink-0 ring-1">
                                <CardHeader className="max-h-[28rem] overflow-y-auto py-4">
                                    <p className="text-text-secondary mb-2 text-xs font-medium">
                                        Selected directories
                                    </p>
                                    {directoryPaths.length === 0 && (
                                        <p className="text-text-tertiary text-xs">
                                            No directories selected
                                        </p>
                                    )}
                                    <TooltipProvider delayDuration={300}>
                                        <div className="flex flex-col gap-1.5">
                                            {directoryPaths.map((path) => (
                                                <Badge
                                                    key={path}
                                                    variant="helper"
                                                    className="w-full justify-between gap-1 pr-1">
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <span
                                                                dir="rtl"
                                                                className="min-w-0 truncate">
                                                                {path}
                                                            </span>
                                                        </TooltipTrigger>
                                                        <TooltipPortal>
                                                            <TooltipContent side="left">
                                                                {path}
                                                            </TooltipContent>
                                                        </TooltipPortal>
                                                    </Tooltip>
                                                    <button
                                                        type="button"
                                                        aria-label={`Remove ${path}`}
                                                        className="text-text-tertiary hover:text-text-primary shrink-0 rounded-sm transition-colors"
                                                        onClick={() =>
                                                            setDirectoryPaths(
                                                                directoryPaths.filter(
                                                                    (
                                                                        selected,
                                                                    ) =>
                                                                        selected !==
                                                                        path,
                                                                ),
                                                            )
                                                        }>
                                                        <XIcon className="size-3" />
                                                    </button>
                                                </Badge>
                                            ))}
                                        </div>
                                    </TooltipProvider>
                                </CardHeader>
                            </Card>
                        </div>
                    </FormControl.Input>
                </FormControl.Root>

                {validPaths.length > 0 && (
                    <div className="border-warning/30 bg-warning/10 text-warning flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs">
                        <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                        <span>
                            PRs will be reviewed when at least one changed file
                            is inside any of the selected directories.
                        </span>
                    </div>
                )}

                <DialogFooter>
                    <Button
                        size="md"
                        variant="primary"
                        onClick={handleSubmit}
                        leftIcon={<FolderPlusIcon />}
                        disabled={validPaths.length === 0}
                        loading={isSubmitting}>
                        {editGroup ? "Save directories" : "Add directory scope"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
