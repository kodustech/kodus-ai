"use client";

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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { useGetSelectedRepositories } from "@services/codeManagement/hooks";
import { CheckIcon, FolderIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

export const SINCE_PRESETS = ["today", "7d", "30d"] as const;
export type SincePreset = (typeof SINCE_PRESETS)[number];
export const SINCE_LABEL: Record<SincePreset, string> = {
    "today": "Today",
    "7d": "Last 7 days",
    "30d": "Last 30 days",
};

/** ISO timestamp for the API's `since` filter: local midnight, N days back. */
export const sinceFromPreset = (preset: SincePreset | null | undefined) => {
    if (!preset) return undefined;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    if (preset === "7d") start.setDate(start.getDate() - 7);
    if (preset === "30d") start.setDate(start.getDate() - 30);
    return start.toISOString();
};

/**
 * Repository + date filters for the CLI tab, in the same voice as the Pull
 * Requests toolbar (helper button + popover list, `sm` select). Only what
 * the executions endpoint can filter server-side is offered.
 */
export const CliReviewsFilters = ({
    teamId,
    repositoryId,
    onRepositoryChange,
    since,
    onSinceChange,
}: {
    teamId: string;
    repositoryId?: string | null;
    onRepositoryChange: (repositoryId?: string) => void;
    since?: SincePreset | null;
    onSinceChange: (value: SincePreset | null) => void;
}) => {
    const [repoOpen, setRepoOpen] = useState(false);
    const { data: repositories = [] } = useGetSelectedRepositories(teamId);
    const selected = useMemo(
        () =>
            Array.isArray(repositories)
                ? repositories.find((repo) => String(repo.id) === repositoryId)
                : undefined,
        [repositories, repositoryId],
    );

    return (
        <>
            <Popover open={repoOpen} onOpenChange={setRepoOpen}>
                <PopoverTrigger asChild>
                    <Button
                        size="sm"
                        variant="helper"
                        leftIcon={<FolderIcon />}
                        className={cn(
                            "h-9 max-w-[14rem] justify-start gap-1.5 rounded-lg",
                            repositoryId && "border-primary-light/50",
                        )}>
                        <span className="truncate">
                            {selected?.name ?? "Repository"}
                        </span>
                    </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-0">
                    <Command>
                        <CommandInput placeholder="Search repositories..." />
                        <CommandList className="max-h-64 overflow-y-auto">
                            <CommandEmpty>No repository found.</CommandEmpty>
                            <CommandGroup>
                                <CommandItem
                                    value="all repositories"
                                    onSelect={() => {
                                        onRepositoryChange(undefined);
                                        setRepoOpen(false);
                                    }}>
                                    <span>All repositories</span>
                                    {!repositoryId && (
                                        <CheckIcon className="text-primary-light -mr-2 size-5" />
                                    )}
                                </CommandItem>
                                {(Array.isArray(repositories)
                                    ? repositories
                                    : []
                                ).map((repo) => (
                                    <CommandItem
                                        key={repo.id}
                                        value={repo.name}
                                        onSelect={() => {
                                            onRepositoryChange(String(repo.id));
                                            setRepoOpen(false);
                                        }}>
                                        <span className="truncate">
                                            <span className="text-text-secondary">
                                                {repo.organizationName}/
                                            </span>
                                            {repo.name}
                                        </span>
                                        {String(repo.id) === repositoryId && (
                                            <CheckIcon className="text-primary-light -mr-2 size-5" />
                                        )}
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        </CommandList>
                    </Command>
                </PopoverContent>
            </Popover>

            <Select
                value={since ?? "all"}
                onValueChange={(value) =>
                    onSinceChange(
                        value === "all" ? null : (value as SincePreset),
                    )
                }>
                <SelectTrigger
                    size="sm"
                    className={cn(
                        "h-9 w-auto gap-1.5 rounded-lg",
                        since && "border-primary-light/50",
                    )}>
                    <SelectValue placeholder="Date" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">Date</SelectItem>
                    {SINCE_PRESETS.map((preset) => (
                        <SelectItem key={preset} value={preset}>
                            {SINCE_LABEL[preset]}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </>
    );
};
