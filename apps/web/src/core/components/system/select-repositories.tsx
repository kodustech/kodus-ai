import { useEffect, useMemo, useRef, useState } from "react";
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
import { Spinner } from "@components/ui/spinner";
import { useGetRepositories } from "@services/codeManagement/hooks";
import type { Repository } from "@services/codeManagement/types";
import { formatDistanceToNow } from "date-fns";
import { Check, ChevronsUpDown } from "lucide-react";
import { pluralize } from "src/core/utils/string";

const ITEMS_PER_BATCH = 30;

export const SelectRepositories = (props: {
    id?: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    selectedRepositories: Repository[];
    onChangeSelectedRepositories: (repositories: Repository[]) => void;
    onFinishLoading?: (hasRepositories: boolean) => void;
    onError?: (hasError: boolean) => void;
    teamId: string;
    /**
     * Optional predicate to narrow which repositories are OFFERED as choices
     * (e.g. only those selected in git settings). Already-selected repositories
     * passed via `selectedRepositories` are always shown regardless, so a
     * previously-picked repo never silently disappears from the list.
     */
    filterRepository?: (repository: Repository) => boolean;
}) => {
    const {
        data: allRepositories = [],
        isLoading,
        isError,
        refetch,
    } = useGetRepositories(props.teamId);

    const repositories = useMemo(
        () =>
            props.filterRepository
                ? allRepositories.filter(props.filterRepository)
                : allRepositories,
        [allRepositories, props.filterRepository],
    );

    useEffect(() => {
        if (!isLoading) props.onFinishLoading?.(repositories.length > 0);
    }, [isLoading, repositories.length]);

    useEffect(() => {
        props.onError?.(isError);
    }, [isError]);

    const handleRetry = () => {
        void refetch();
    };

    const {
        id = "select-repositories",
        open,
        onOpenChange,
        selectedRepositories,
        onChangeSelectedRepositories,
    } = props;

    const [search, setSearch] = useState("");
    const [displayedCount, setDisplayedCount] = useState(ITEMS_PER_BATCH);
    const commandListRef = useRef<HTMLDivElement | null>(null);
    const isLoadingMoreRef = useRef(false);

    useEffect(() => {
        if (!open) {
            setSearch("");
            setDisplayedCount(ITEMS_PER_BATCH);
            isLoadingMoreRef.current = false;
        }
    }, [open]);

    useEffect(() => {
        setDisplayedCount(ITEMS_PER_BATCH);
        isLoadingMoreRef.current = false;
    }, [search]);

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

    const visibleSelected = filteredSelected.slice(0, displayedCount);
    const visibleUnselected = filteredUnselected.slice(
        0,
        Math.max(0, displayedCount - filteredSelected.length),
    );
    const total = filteredSelected.length + filteredUnselected.length;
    const hasMore = displayedCount < total;

    useEffect(() => {
        if (!open) return;

        let listElement: HTMLDivElement | null = null;
        let handleScroll: (() => void) | null = null;

        const timer = setTimeout(() => {
            const el = commandListRef.current;
            if (!el || !hasMore) return;

            listElement = el;
            handleScroll = () => {
                if (isLoadingMoreRef.current) return;

                const { scrollTop, scrollHeight, clientHeight } = el;
                const distanceFromBottom =
                    scrollHeight - scrollTop - clientHeight;

                if (distanceFromBottom < 100) {
                    isLoadingMoreRef.current = true;

                    requestAnimationFrame(() => {
                        setDisplayedCount((prev) => {
                            const next = Math.min(
                                prev + ITEMS_PER_BATCH,
                                total,
                            );
                            setTimeout(() => {
                                isLoadingMoreRef.current = false;
                            }, 100);
                            return next;
                        });
                    });
                }
            };

            el.addEventListener("scroll", handleScroll, { passive: true });
        }, 100);

        return () => {
            clearTimeout(timer);
            if (listElement && handleScroll) {
                listElement.removeEventListener("scroll", handleScroll);
            }
        };
    }, [open, displayedCount, total]);

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

                    <CommandList
                        ref={(node) => {
                            commandListRef.current =
                                node as HTMLDivElement | null;
                        }}
                        className="max-h-56 overflow-y-auto">
                        <CommandEmpty>No repository found.</CommandEmpty>

                        {isError && (
                            <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                                <span className="text-text-secondary text-sm">
                                    Failed to load repositories. Please try
                                    again.
                                </span>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={handleRetry}>
                                    Try again
                                </Button>
                            </div>
                        )}

                        {selectedRepositories.length > 0 && (
                            <CommandGroup heading="Selected">
                                {visibleSelected.map((r) => (
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
                                {visibleUnselected.map((r) => (
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

                        {hasMore && (
                            <div className="flex items-center justify-center py-2">
                                <Spinner className="size-4" />
                            </div>
                        )}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
};
