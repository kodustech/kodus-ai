import { useEffect, useMemo, useState } from "react";
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
import { useGetRepositories } from "@services/codeManagement/hooks";
import type { Repository } from "@services/codeManagement/types";
import { formatDistanceToNow } from "date-fns";
import { Check, ChevronsUpDown } from "lucide-react";
import { pluralize } from "src/core/utils/string";

export const SelectRepositories = (props: {
    id?: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    selectedRepositories: Repository[];
    onChangeSelectedRepositories: (repositories: Repository[]) => void;
    onFinishLoading?: (hasRepositories: boolean) => void;
    teamId: string;
}) => {
    const { data: repositories = [], isLoading } = useGetRepositories(
        props.teamId,
    );

    useEffect(() => {
        if (!isLoading) props.onFinishLoading?.(repositories.length > 0);
    }, [isLoading, repositories.length]);

    const {
        id = "select-repositories",
        open,
        onOpenChange,
        selectedRepositories,
        onChangeSelectedRepositories,
    } = props;

    const [search, setSearch] = useState("");

    useEffect(() => {
        if (!open) setSearch("");
    }, [open]);

    const sortedRepositories = useMemo(() => {
        return [...repositories].sort((a, b) => {
            const aTime = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
            const bTime = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;

            if (bTime !== aTime) return bTime - aTime;

            return a.name.localeCompare(b.name);
        });
    }, [repositories]);

    const unselectedRepositories = useMemo(
        () =>
            sortedRepositories.filter(
                (r) => !selectedRepositories.some((s) => s.id === r.id),
            ),
        [sortedRepositories, selectedRepositories],
    );

    const matchesSearch = (repo: Repository) => {
        if (!search) return true;
        const s = search.toLowerCase();
        return (
            repo.name.toLowerCase().includes(s) ||
            repo.organizationName.toLowerCase().includes(s)
        );
    };

    const filteredUnselected = useMemo(
        () => unselectedRepositories.filter(matchesSearch),
        [unselectedRepositories, search],
    );

    const filteredSelected = useMemo(
        () => selectedRepositories.filter(matchesSearch),
        [selectedRepositories, search],
    );

    const formatLastActivity = (date?: string) => {
        if (!date) return null;
        const parsed = new Date(date);
        if (Number.isNaN(parsed.getTime())) return null;
        return formatDistanceToNow(parsed, { addSuffix: true });
    };

    return (
        <Popover open={open} onOpenChange={onOpenChange} modal>
            <PopoverTrigger asChild>
                <Button
                    size="lg"
                    variant="helper"
                    role="combobox"
                    loading={isLoading}
                    aria-expanded={open}
                    className="w-full justify-between"
                    id={id}
                    rightIcon={<ChevronsUpDown className="-mr-2 opacity-50" />}>
                    {selectedRepositories.length > 0 ? (
                        `${selectedRepositories.length} ${pluralize(
                            selectedRepositories.length,
                            {
                                singular: "repository",
                                plural: "repositories",
                            },
                        )} selected`
                    ) : (
                        <span>Select repositories...</span>
                    )}
                </Button>
            </PopoverTrigger>

            <PopoverContent className="w-[var(--radix-popper-anchor-width)] p-0">
                <Command
                    filter={(value, search) => {
                        const repository = sortedRepositories.find(
                            (r) => r.id === value,
                        );

                        if (!repository) return 0;

                        if (
                            repository.name
                                .toLowerCase()
                                .includes(search.toLowerCase()) ||
                            repository.organizationName
                                .toLowerCase()
                                .includes(search.toLowerCase())
                        ) {
                            return 1;
                        }

                        return 0;
                    }}>
                    <CommandInput
                        placeholder="Search repository..."
                        onValueChange={setSearch}
                    />

                    {(filteredUnselected.length > 0 ||
                        filteredSelected.length > 0) && (
                        <div className="flex justify-end gap-3 border-b px-3 py-1.5">
                            {filteredSelected.length > 0 && (
                                <button
                                    type="button"
                                    className="text-text-secondary hover:text-text-primary cursor-pointer text-xs font-medium"
                                    onClick={() => {
                                        const idsToRemove = new Set(
                                            filteredSelected.map((r) => r.id),
                                        );
                                        onChangeSelectedRepositories(
                                            selectedRepositories.filter(
                                                (r) => !idsToRemove.has(r.id),
                                            ),
                                        );
                                    }}>
                                    Clear selection
                                    {search
                                        ? ` (${filteredSelected.length})`
                                        : ""}
                                </button>
                            )}
                            {filteredUnselected.length > 0 && (
                                <button
                                    type="button"
                                    className="text-primary-light hover:text-primary-dark cursor-pointer text-xs font-medium"
                                    onClick={() => {
                                        onChangeSelectedRepositories([
                                            ...selectedRepositories,
                                            ...filteredUnselected,
                                        ]);
                                    }}>
                                    Select all
                                    {search
                                        ? ` (${filteredUnselected.length})`
                                        : ""}
                                </button>
                            )}
                        </div>
                    )}

                    <CommandList className="max-h-56 overflow-y-auto">
                        <CommandEmpty>No repository found.</CommandEmpty>

                        {selectedRepositories.length > 0 && (
                            <CommandGroup heading="Selected">
                                {selectedRepositories.map((r) => (
                                    <CommandItem
                                        key={r.id}
                                        value={r.id}
                                        onSelect={(currentValue) => {
                                            onChangeSelectedRepositories(
                                                selectedRepositories.filter(
                                                    (repo) =>
                                                        repo.id !==
                                                        currentValue,
                                                ),
                                            );
                                        }}>
                                        <span className="flex flex-col items-start gap-1 text-left">
                                            <span>
                                                <span className="text-text-secondary">
                                                    {r.organizationName}/
                                                </span>
                                                {r.name}
                                            </span>
                                            {formatLastActivity(
                                                r.lastActivityAt,
                                            ) && (
                                                <span className="text-text-tertiary text-xs">
                                                    Last activity{" "}
                                                    {formatLastActivity(
                                                        r.lastActivityAt,
                                                    )}
                                                </span>
                                            )}
                                        </span>

                                        <Check className="text-primary-light -mr-2 size-5" />
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        )}
                        {unselectedRepositories.length > 0 && (
                            <CommandGroup heading="Not selected">
                                {unselectedRepositories.map((r) => (
                                    <CommandItem
                                        key={r.id}
                                        value={r.id}
                                        onSelect={(currentValue) => {
                                            onChangeSelectedRepositories([
                                                ...selectedRepositories,
                                                sortedRepositories.find(
                                                    (repo) =>
                                                        repo.id ===
                                                        currentValue,
                                                )!,
                                            ]);
                                        }}>
                                        <span className="flex flex-col items-start gap-1 text-left">
                                            <span>
                                                <span className="text-text-secondary">
                                                    {r.organizationName}/
                                                </span>
                                                {r.name}
                                            </span>
                                            {formatLastActivity(
                                                r.lastActivityAt,
                                            ) && (
                                                <span className="text-text-tertiary text-xs">
                                                    Last activity{" "}
                                                    {formatLastActivity(
                                                        r.lastActivityAt,
                                                    )}
                                                </span>
                                            )}
                                        </span>
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        )}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
};
