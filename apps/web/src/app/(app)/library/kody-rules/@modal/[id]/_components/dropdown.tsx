import { useMemo, useState } from "react";
import { Button } from "@components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { Check, ChevronDown } from "lucide-react";
import type { CodeReviewRepositoryConfig } from "src/app/(app)/settings/code-review/_types";
import type { LiteralUnion } from "src/core/types";

export const SelectRepositoriesDropdown = ({
    repositories: _repositories,
    selectedDirectoriesIds,
    selectedRepositoriesIds,
    setSelectedDirectoriesIds,
    setSelectedRepositoriesIds,
    canEdit,
    global = true,
}: {
    selectedRepositoriesIds: string[];
    selectedDirectoriesIds: Array<{
        directoryId: string;
        repositoryId: string;
    }>;
    setSelectedRepositoriesIds: (s: typeof selectedRepositoriesIds) => void;
    setSelectedDirectoriesIds: (s: typeof selectedDirectoriesIds) => void;
    repositories: Array<CodeReviewRepositoryConfig>;
    canEdit: boolean;
    global?: boolean;
}) => {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");

    const repositories: Array<
        Omit<CodeReviewRepositoryConfig, "configs"> & {
            id: LiteralUnion<"global">;
        }
    > = global
        ? [{ id: "global", name: "Global", isSelected: false }].concat(
              _repositories,
          )
        : _repositories;

    const matchesSearch = (repo: (typeof repositories)[0]) => {
        if (!search) return true;
        return repo.name.toLowerCase().includes(search.toLowerCase());
    };

    const selectedRepos = useMemo(
        () =>
            repositories
                .filter((r) => selectedRepositoriesIds.includes(r.id))
                .filter(matchesSearch),
        [repositories, selectedRepositoriesIds, search],
    );
    const unselectedRepos = useMemo(
        () =>
            repositories
                .filter((r) => !selectedRepositoriesIds.includes(r.id))
                .filter(matchesSearch),
        [repositories, selectedRepositoriesIds, search],
    );

    return (
        <Popover
            open={open}
            onOpenChange={(o) => {
                setOpen(o);
                if (!o) setSearch("");
            }}>
            <PopoverTrigger asChild>
                <Button
                    size="md"
                    variant="primary"
                    disabled={!canEdit}
                    className="group rounded-l-none px-3">
                    <ChevronDown className="size-4 transition-transform group-data-[state=closed]:rotate-180" />
                </Button>
            </PopoverTrigger>

            <PopoverContent
                align="end"
                side="top"
                sideOffset={10}
                alignOffset={-40}
                className="w-72 translate-x-6 p-0">
                <Command filter={() => 1}>
                    <CommandInput
                        placeholder="Search repositories..."
                        onValueChange={setSearch}
                    />

                    {(selectedRepos.length > 0 ||
                        unselectedRepos.length > 0) && (
                        <div className="flex justify-end gap-3 border-b px-3 py-1.5">
                            {selectedRepos.length > 0 && (
                                <button
                                    type="button"
                                    className="text-text-secondary hover:text-text-primary cursor-pointer text-xs font-medium"
                                    onClick={() => {
                                        const idsToRemove = new Set(
                                            selectedRepos.map((r) => r.id),
                                        );
                                        setSelectedRepositoriesIds(
                                            selectedRepositoriesIds.filter(
                                                (id) => !idsToRemove.has(id),
                                            ),
                                        );
                                    }}>
                                    Clear selection
                                    {search ? ` (${selectedRepos.length})` : ""}
                                </button>
                            )}
                            {unselectedRepos.length > 0 && (
                                <button
                                    type="button"
                                    className="text-primary-light hover:text-primary-dark cursor-pointer text-xs font-medium"
                                    onClick={() => {
                                        const idsToAdd = unselectedRepos.map(
                                            (r) => r.id,
                                        );
                                        setSelectedRepositoriesIds([
                                            ...selectedRepositoriesIds,
                                            ...idsToAdd,
                                        ]);
                                    }}>
                                    Select all
                                    {search
                                        ? ` (${unselectedRepos.length})`
                                        : ""}
                                </button>
                            )}
                        </div>
                    )}

                    <CommandList className="max-h-[300px] overflow-y-auto">
                        <CommandEmpty>No repository found.</CommandEmpty>

                        <div
                            className="m-0 max-h-[220px] overflow-y-auto p-0"
                            onWheel={(e) => e.stopPropagation()}>
                            {selectedRepos.length > 0 && (
                                <CommandGroup heading="Selected">
                                    {selectedRepos.map((r) => (
                                        <CommandItem
                                            key={r.id}
                                            value={r.id}
                                            onSelect={() => {
                                                setSelectedRepositoriesIds(
                                                    selectedRepositoriesIds.filter(
                                                        (id) => id !== r.id,
                                                    ),
                                                );
                                            }}>
                                            <span className="flex flex-1 flex-col items-start gap-1 text-left">
                                                <span>{r.name}</span>
                                                {r.directories &&
                                                    r.directories.length >
                                                        0 && (
                                                        <div className="flex flex-wrap gap-1">
                                                            {r.directories
                                                                .filter((d) =>
                                                                    selectedDirectoriesIds.some(
                                                                        (sd) =>
                                                                            sd.directoryId ===
                                                                            d.id,
                                                                    ),
                                                                )
                                                                .map((d) => (
                                                                    <span
                                                                        key={
                                                                            d.id
                                                                        }
                                                                        className="text-text-tertiary text-xs">
                                                                        {d.folders?.[0]?.path ?? d.name}
                                                                    </span>
                                                                ))}
                                                        </div>
                                                    )}
                                            </span>
                                            <Check className="text-primary-light -mr-2 size-5" />
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            )}

                            {unselectedRepos.length > 0 && (
                                <CommandGroup heading="Not selected">
                                    {unselectedRepos.map((r) => (
                                        <CommandItem
                                            key={r.id}
                                            value={r.id}
                                            onSelect={() => {
                                                setSelectedRepositoriesIds([
                                                    ...selectedRepositoriesIds,
                                                    r.id,
                                                ]);
                                            }}>
                                            <span className="flex flex-1 flex-col items-start gap-1 text-left">
                                                <span>{r.name}</span>
                                                {r.directories &&
                                                    r.directories.length >
                                                        0 && (
                                                        <span className="text-text-tertiary text-xs">
                                                            {
                                                                r.directories
                                                                    .length
                                                            }{" "}
                                                            director
                                                            {r.directories
                                                                .length > 1
                                                                ? "ies"
                                                                : "y"}
                                                        </span>
                                                    )}
                                            </span>
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            )}
                        </div>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
};
