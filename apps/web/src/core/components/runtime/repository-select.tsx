"use client";

import { useState } from "react";
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
import type { RunsRepositories } from "@services/runtime/model/runs-repositories";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

/**
 * Picks one of the repositories with an environment, with its state: only they have Runs, and the list is per
 * repository. A search box filters them by name, as the environments list does.
 */
export const RepositorySelect = ({
    repositories,
    value,
    onChange,
}: {
    repositories: Pick<RunsRepositories, "withEnvironment">;
    value: string | undefined;
    onChange: (repositoryId: string) => void;
}) => {
    const [open, setOpen] = useState(false);
    const current = repositories.withEnvironment.find((r) => r.id === value);
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    role="combobox"
                    aria-expanded={open}
                    aria-label="Repository"
                    className="border-card-lv3 bg-card-lv1 hover:bg-card-lv2 focus-visible:ring-ring flex h-10 w-72 items-center gap-2 rounded-xl border px-4 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2">
                    <span className="min-w-0 flex-1 truncate">
                        {current ? current.name : "Choose a repository"}
                    </span>
                    {current?.status && (
                        <span className="text-text-tertiary shrink-0 text-xs">
                            {current.status.label}
                        </span>
                    )}
                    <ChevronsUpDownIcon
                        className="text-text-tertiary size-4 shrink-0"
                        aria-hidden
                    />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-0">
                {/* By part of the name, not cmdk's fuzzy score: "bill" finds billing, never mobile. */}
                <Command
                    filter={(_value, search, keywords) =>
                        (keywords ?? []).some((k) =>
                            k.toLowerCase().includes(search.toLowerCase()),
                        )
                            ? 1
                            : 0
                    }>
                    <CommandInput placeholder="Search repositories…" />
                    <CommandList>
                        <CommandEmpty>No repository matches.</CommandEmpty>
                        <CommandGroup>
                            {repositories.withEnvironment.map((repository) => (
                                <CommandItem
                                    key={repository.id}
                                    value={repository.id}
                                    keywords={[repository.name]}
                                    onSelect={() => {
                                        onChange(repository.id);
                                        setOpen(false);
                                    }}>
                                    <CheckIcon
                                        aria-hidden
                                        className={cn(
                                            "size-4 shrink-0",
                                            repository.id === value
                                                ? "opacity-100"
                                                : "opacity-0",
                                        )}
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                        {repository.name}
                                    </span>
                                    {repository.status && (
                                        <span className="text-text-tertiary shrink-0 text-xs">
                                            {repository.status.label}
                                        </span>
                                    )}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
};
