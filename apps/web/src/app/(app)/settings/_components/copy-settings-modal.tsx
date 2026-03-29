import { Suspense, useMemo, useState } from "react";
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
import { Check, CopyPlusIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { GitDirectorySelector } from "../code-review/_components/git-directory-selector";

type Repository = {
    id: string;
    name: string;
    isSelected?: boolean;
};

export const AddRepoModal = ({
    repositories,
}: {
    repositories: Repository[];
}) => {
    const { teamId } = useSelectedTeamId();
    const { resetQueries, generateQueryKey } = useReactQueryInvalidateQueries();

    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [directoryPath, setDirectoryPath] = useState<string>("/");
    const [search, setSearch] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [showRepoList, setShowRepoList] = useState(false);

    const matchesSearch = (repo: Repository) => {
        if (!search) return true;
        return repo.name.toLowerCase().includes(search.toLowerCase());
    };

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
            const targetDirectoryPath = singleSelectedRepoId
                ? directoryPath
                : "/";

            for (const repoId of selectedIds) {
                await createOrUpdateCodeReviewParameter(
                    {},
                    teamId,
                    repoId,
                    undefined,
                    targetDirectoryPath,
                );
            }

            await Promise.all([
                resetQueries({
                    queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                        params: {
                            key: ParametersConfigKey.CODE_REVIEW_CONFIG,
                            teamId,
                        },
                    }),
                }),
                resetQueries({
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
                onOpenAutoFocus={(e) => e.preventDefault()}>
                <DialogHeader>
                    <DialogTitle>Create repository settings</DialogTitle>
                </DialogHeader>

                <FormControl.Root>
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
                                    placeholder="Search repository..."
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
                                        onMouseDown={(e) =>
                                            e.preventDefault()
                                        }>
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
                </FormControl.Root>

                {singleSelectedRepoId && (
                    <FormControl.Root>
                        <FormControl.Label>
                            Select the target directory
                        </FormControl.Label>

                        <FormControl.Input>
                            <Card className="ring-1">
                                <Suspense
                                    fallback={
                                        <CardHeader className="flex-row items-center gap-5 py-4 text-sm">
                                            <Spinner className="size-6" />
                                            <span className="text-text-secondary">
                                                Loading directories
                                            </span>
                                        </CardHeader>
                                    }>
                                    <CardHeader className="max-h-64 overflow-y-auto py-4">
                                        <GitDirectorySelector
                                            value={directoryPath}
                                            repositoryId={singleSelectedRepoId}
                                            onValueChange={setDirectoryPath}
                                        />
                                    </CardHeader>
                                </Suspense>
                            </Card>
                        </FormControl.Input>

                        {directoryPath && (
                            <FormControl.Helper>
                                Selected directory is
                                <span className="text-primary-light ml-1">
                                    {directoryPath}
                                </span>
                            </FormControl.Helper>
                        )}
                    </FormControl.Root>
                )}

                <DialogFooter>
                    <Button
                        size="md"
                        variant="primary"
                        onClick={handleSubmit}
                        leftIcon={<CopyPlusIcon />}
                        disabled={selectedIds.length === 0}
                        loading={isSubmitting}>
                        Create settings
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
