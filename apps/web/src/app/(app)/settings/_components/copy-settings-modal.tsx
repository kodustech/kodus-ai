import { Suspense, useMemo, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@components/ui/command";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { magicModal } from "@components/ui/magic-modal";
import { Spinner } from "@components/ui/spinner";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { PARAMETERS_PATHS } from "@services/parameters";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import { ParametersConfigKey } from "@services/parameters/types";
import { Check, CopyPlusIcon, InfoIcon, XIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import {
    Tooltip,
    TooltipContent,
    TooltipPortal,
    TooltipProvider,
    TooltipTrigger,
} from "@components/ui/tooltip";

import { GitDirectorySelector } from "../code-review/_components/git-directory-selector";

type Repository = {
    id: string;
    name: string;
    isSelected?: boolean;
};

type EditGroupContext = {
    repositoryId: string;
    directoryId: string;
    initialPaths: string[];
};

export const AddRepoModal = ({
    repositories,
    editGroup,
}: {
    repositories: Repository[];
    editGroup?: EditGroupContext;
}) => {
    const { teamId } = useSelectedTeamId();
    const { invalidateQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();

    const isEditMode = !!editGroup;
    const [selectedIds, setSelectedIds] = useState<string[]>(
        editGroup ? [editGroup.repositoryId] : [],
    );
    const [directoryPaths, setDirectoryPaths] = useState<string[]>(
        editGroup?.initialPaths ?? [],
    );
    const [search, setSearch] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [showRepoList, setShowRepoList] = useState(false);

    const selectedRepositories = useMemo(
        () => repositories.filter((r) => selectedIds.includes(r.id)),
        [repositories, selectedIds],
    );

    const unselectedRepositories = useMemo(
        () => repositories.filter((r) => !selectedIds.includes(r.id)),
        [repositories, selectedIds],
    );

    const singleSelectedRepoId =
        selectedIds.length === 1 ? selectedIds[0] : null;

    const handleSubmit = async () => {
        magicModal.lock();
        setIsSubmitting(true);

        try {
            const paths =
                singleSelectedRepoId && directoryPaths.length > 0
                    ? directoryPaths
                    : undefined;

            if (isEditMode) {
                await createOrUpdateCodeReviewParameter(
                    {},
                    teamId,
                    editGroup.repositoryId,
                    editGroup.directoryId,
                    paths,
                );
            } else {
                for (const repoId of selectedIds) {
                    await createOrUpdateCodeReviewParameter(
                        {},
                        teamId,
                        repoId,
                        undefined,
                        paths,
                    );
                }
            }

            await Promise.all([
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
                        {
                            params: {
                                teamId,
                            },
                        },
                    ),
                }),
            ]);

            magicModal.hide(true);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent
                className="max-w-5xl"
                onOpenAutoFocus={(e) => e.preventDefault()}>
                <DialogHeader>
                    <DialogTitle>
                        {isEditMode
                            ? "Edit directory group"
                            : "Create repository settings"}
                    </DialogTitle>
                </DialogHeader>

                {!isEditMode && <FormControl.Root>
                    <FormControl.Label>
                        Select the target repository
                    </FormControl.Label>

                    <FormControl.Input>
                        <Card className="ring-1">
                            <Command
                                filter={(value, search) => {
                                    const repository = repositories.find(
                                        (r) => r.id === value,
                                    );

                                    if (!repository) return 0;

                                    return repository.name
                                        .toLowerCase()
                                        .includes(search.toLowerCase())
                                        ? 1
                                        : 0;
                                }}>
                                <CommandInput
                                    placeholder={
                                        selectedRepositories.length > 0
                                            ? selectedRepositories
                                                  .map((r) => r.name)
                                                  .join(", ")
                                            : "Search repository..."
                                    }
                                    onValueChange={(value) => {
                                        setSearch(value);
                                        setShowRepoList(true);
                                    }}
                                    onClick={() => setShowRepoList(true)}
                                    onBlur={() =>
                                        setTimeout(
                                            () => setShowRepoList(false),
                                            150,
                                        )
                                    }
                                />

                                {showRepoList && (
                                    <CommandList
                                        className="max-h-56 overflow-y-auto"
                                        onMouseDown={(e) => e.preventDefault()}>
                                        <CommandEmpty>
                                            No repository found.
                                        </CommandEmpty>

                                        {selectedRepositories.length > 0 && (
                                            <CommandGroup heading="Selected">
                                                {selectedRepositories.map(
                                                    (r) => (
                                                        <CommandItem
                                                            key={r.id}
                                                            value={r.id}
                                                            onSelect={(
                                                                currentValue,
                                                            ) => {
                                                                setSelectedIds(
                                                                    selectedIds.filter(
                                                                        (id) =>
                                                                            id !==
                                                                            currentValue,
                                                                    ),
                                                                );
                                                            }}>
                                                            {r.name}
                                                            <Check className="text-primary-light -mr-2 size-5" />
                                                        </CommandItem>
                                                    ),
                                                )}
                                            </CommandGroup>
                                        )}

                                        {unselectedRepositories.length > 0 && (
                                            <CommandGroup heading="Not selected">
                                                {unselectedRepositories.map(
                                                    (r) => (
                                                        <CommandItem
                                                            key={r.id}
                                                            value={r.id}
                                                            onSelect={(
                                                                currentValue,
                                                            ) => {
                                                                setSelectedIds([
                                                                    ...selectedIds,
                                                                    currentValue,
                                                                ]);
                                                            }}>
                                                            {r.name}
                                                        </CommandItem>
                                                    ),
                                                )}
                                            </CommandGroup>
                                        )}
                                    </CommandList>
                                )}
                            </Command>
                        </Card>
                    </FormControl.Input>

                    <FormControl.Helper>
                        The changes you make in this repository will override
                        global defaults.
                    </FormControl.Helper>
                </FormControl.Root>}

                {singleSelectedRepoId && (
                    <FormControl.Root>
                        <FormControl.Label>
                            Select the target directories
                        </FormControl.Label>

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
                                                repositoryId={
                                                    singleSelectedRepoId
                                                }
                                                excludeGroupId={
                                                    editGroup?.directoryId
                                                }
                                                onValueChange={
                                                    setDirectoryPaths
                                                }
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
                                                            <TooltipTrigger
                                                                asChild>
                                                                <span
                                                                    dir="rtl"
                                                                    className="min-w-0 truncate">
                                                                    {path}
                                                                </span>
                                                            </TooltipTrigger>
                                                            <TooltipPortal>
                                                                <TooltipContent
                                                                    side="left">
                                                                    {path}
                                                                </TooltipContent>
                                                            </TooltipPortal>
                                                        </Tooltip>
                                                        <button
                                                            type="button"
                                                            className="text-text-tertiary hover:text-text-primary shrink-0 rounded-sm transition-colors"
                                                            onClick={() =>
                                                                setDirectoryPaths(
                                                                    directoryPaths.filter(
                                                                        (p) =>
                                                                            p !==
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
                )}

                {singleSelectedRepoId && directoryPaths.length > 0 && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-400">
                        <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                        <span>
                            PRs will be reviewed when at least one changed
                            file is inside any of the selected{" "}
                            {directoryPaths.length === 1
                                ? "directory"
                                : "directories"}
                            .
                        </span>
                    </div>
                )}

                <DialogFooter>
                    <Button
                        size="md"
                        variant="primary"
                        onClick={handleSubmit}
                        leftIcon={<CopyPlusIcon />}
                        disabled={
                            isEditMode
                                ? directoryPaths.length === 0
                                : selectedIds.length === 0
                        }
                        loading={isSubmitting}>
                        {isEditMode ? "Save directories" : "Create settings"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
