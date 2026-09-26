"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
import { useGetSelectedRepositories } from "@services/codeManagement/hooks";
import { Check, GitBranch } from "lucide-react";
import { parseAsString, useQueryStates } from "nuqs";
import { safeArray } from "src/core/utils/safe-array";

import { setCockpitRepositoryCookie } from "../_actions/set-cockpit-repository";
import { COCKPIT_PARAM } from "../_constants";

type Props = {
    cookieValue: string | undefined;
    teamId: string;
};

const ITEMS_PER_BATCH = 50;

export const RepositoryPicker = ({ cookieValue, teamId }: Props) => {
    const { data: repositories = [], isLoading } =
        useGetSelectedRepositories(teamId);

    const [{ repository: repositoryParam }, setRepositoryParams] =
        useQueryStates({
            repository: parseAsString,
            repositoryId: parseAsString,
        });
    const [loading, startTransition] = useTransition();
    const [open, setOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [displayedCount, setDisplayedCount] = useState(ITEMS_PER_BATCH);
    const commandListRef = useRef<HTMLDivElement | null>(null);
    const isLoadingMoreRef = useRef(false);

    const [selectedRepository, setSelectedRepository] = useState<string>(() => {
        // URL wins: a shared link reflects its repository in the trigger.
        if (repositoryParam !== null) {
            return repositoryParam;
        }
        if (!cookieValue) return "";
        try {
            const parsed = JSON.parse(cookieValue) as
                | string
                | { repository?: string };
            return typeof parsed === "string" ? parsed : parsed.repository ?? "";
        } catch {
            return "";
        }
    });

    // Persist to cookie (cross-session default) and push the selection
    // onto the URL (source of truth) so the view is shareable. An empty
    // value means "all repositories".
    const commitRepository = (
        repositoryFullName: string,
        repositoryId?: string,
    ) => {
        startTransition(async () => {
            await setCockpitRepositoryCookie(repositoryFullName, repositoryId);
            await setRepositoryParams(
                {
                    // Keep ?repository= when clearing so the server reader
                    // treats "all repositories" as authoritative over cookies.
                    repository: repositoryFullName,
                    repositoryId: repositoryId ?? null,
                },
                { shallow: false },
            );
        });
    };

    const filteredRepositories = safeArray(repositories).filter((r) => {
        if (!searchQuery.trim()) return true;
        const query = searchQuery.toLowerCase();
        const fullName = r.full_name || r.name || "";
        const orgName = r.organizationName || "";
        return (
            fullName.toLowerCase().includes(query) ||
            orgName.toLowerCase().includes(query)
        );
    });

    const displayedRepositories = filteredRepositories.slice(0, displayedCount);
    const hasMore = displayedCount < filteredRepositories.length;

    const handleSelect = (repositoryFullName: string, repositoryId: string) => {
        if (!repositoryFullName) return;

        setSelectedRepository(repositoryFullName);
        setOpen(false);
        commitRepository(repositoryFullName, repositoryId);
    };

    const handleClearFilter = () => {
        setSelectedRepository("");
        setOpen(false);
        commitRepository("");
    };

    useEffect(() => {
        if (!open) {
            setDisplayedCount(ITEMS_PER_BATCH);
            setSearchQuery("");
            isLoadingMoreRef.current = false;
        }
    }, [open]);

    useEffect(() => {
        setDisplayedCount(ITEMS_PER_BATCH);
        isLoadingMoreRef.current = false;
    }, [searchQuery]);

    useEffect(() => {
        if (!open) return;

        const timer = setTimeout(() => {
            const listElement = commandListRef.current;
            if (!listElement) {
                return;
            }

            const handleScroll = () => {
                if (isLoadingMoreRef.current) return;

                const { scrollTop, scrollHeight, clientHeight } = listElement;
                const distanceFromBottom =
                    scrollHeight - scrollTop - clientHeight;

                if (
                    distanceFromBottom < 100 &&
                    displayedCount < filteredRepositories.length
                ) {
                    isLoadingMoreRef.current = true;

                    requestAnimationFrame(() => {
                        setDisplayedCount((prev) => {
                            const next = Math.min(
                                prev + ITEMS_PER_BATCH,
                                filteredRepositories.length,
                            );
                            setTimeout(() => {
                                isLoadingMoreRef.current = false;
                            }, 100);
                            return next;
                        });
                    });
                }
            };

            listElement.addEventListener("scroll", handleScroll, {
                passive: true,
            });

            return () => {
                listElement.removeEventListener("scroll", handleScroll);
            };
        }, 100);

        return () => clearTimeout(timer);
    }, [open, displayedCount, filteredRepositories.length]);

    return (
        <>
            {loading && (
                <div className="fixed inset-0 z-5 flex flex-col items-center justify-center gap-4 bg-black/70 backdrop-blur-sm">
                    <Spinner className="size-16" />

                    <span className="text-sm font-semibold">
                        Loading cockpit for
                        <span className="text-primary-light ml-1 font-semibold">
                            {selectedRepository || "all repositories"}
                        </span>
                    </span>
                </div>
            )}

            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button
                        size="md"
                        variant="helper"
                        loading={isLoading}
                        data-disabled={undefined}
                        leftIcon={<GitBranch />}
                        className="w-68 justify-start">
                        {selectedRepository ? (
                            <span className="truncate font-semibold">
                                {selectedRepository}
                            </span>
                        ) : (
                            <span className="text-text-secondary font-semibold">
                                All repositories
                            </span>
                        )}
                    </Button>
                </PopoverTrigger>

                <PopoverContent align="end" className="w-80 p-0">
                    <Command shouldFilter={false}>
                        <CommandInput
                            placeholder="Search repository..."
                            value={searchQuery}
                            onValueChange={setSearchQuery}
                        />

                        <CommandList
                            ref={(node) => {
                                commandListRef.current =
                                    node as HTMLDivElement | null;
                            }}
                            className="max-h-56 overflow-y-auto">
                            {filteredRepositories.length === 0 ? (
                                <CommandEmpty>
                                    No repository found.
                                </CommandEmpty>
                            ) : (
                                <CommandGroup>
                                    {!selectedRepository && (
                                        <CommandItem
                                            value="all"
                                            onSelect={() => setOpen(false)}
                                            className="font-semibold">
                                            <span>All repositories</span>
                                            <Check className="text-primary-light -mr-2 size-5" />
                                        </CommandItem>
                                    )}
                                    {selectedRepository && (
                                        <CommandItem
                                            value="all"
                                            onSelect={handleClearFilter}>
                                            <span>All repositories</span>
                                        </CommandItem>
                                    )}

                                    {displayedRepositories.map((r) => {
                                        const fullName =
                                            r.full_name || r.name;
                                        const displayName =
                                            fullName || "Unknown";

                                        return (
                                            <CommandItem
                                                key={r.id}
                                                value={fullName || r.id}
                                                onSelect={() =>
                                                    handleSelect(fullName, r.id)
                                                }>
                                                <span>{displayName}</span>
                                                {selectedRepository ===
                                                    fullName && (
                                                    <Check className="text-primary-light -mr-2 size-5" />
                                                )}
                                            </CommandItem>
                                        );
                                    })}
                                    {hasMore && (
                                        <div className="flex items-center justify-center py-2">
                                            <Spinner className="size-4" />
                                        </div>
                                    )}
                                </CommandGroup>
                            )}
                        </CommandList>
                    </Command>
                </PopoverContent>
            </Popover>
        </>
    );
};
