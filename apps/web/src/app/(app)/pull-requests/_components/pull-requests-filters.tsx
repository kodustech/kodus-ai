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
import { Action, ResourceType } from "@services/permissions/types";
import { CheckIcon, FolderIcon } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { usePermissions } from "src/core/providers/permissions.provider";
import { cn } from "src/core/utils/components";
import { hasPermission } from "src/core/utils/permission-map";

import { PullRequestsDateRange } from "./pull-requests-date-range";

type SuggestionsFilterValue = "all" | "true" | "false";
type AuthorPolicyFilterValue = "all" | "reviewable" | "excluded";

// The long-tail filters, rendered inline in the toolbar (repo, author policy,
// Kody suggestions, review-date range). Status and the title/number search live
// directly in page.client, so they are intentionally NOT here.
interface PullRequestsFiltersProps {
    teamId: string;
    selectedRepository?: string;
    onRepositoryChange: (repoName?: string) => void;
    suggestionsFilter: SuggestionsFilterValue;
    onSuggestionsFilterChange: (value: SuggestionsFilterValue) => void;
    authorPolicy: AuthorPolicyFilterValue;
    onAuthorPolicyChange: (value: AuthorPolicyFilterValue) => void;
    createdAtFrom?: string | null;
    createdAtTo?: string | null;
    onCreatedAtFromChange: (value: string) => void;
    onCreatedAtToChange: (value: string) => void;
}

export const PullRequestsFilters = ({
    teamId,
    selectedRepository,
    onRepositoryChange,
    suggestionsFilter,
    onSuggestionsFilterChange,
    authorPolicy,
    onAuthorPolicyChange,
    createdAtFrom,
    createdAtTo,
    onCreatedAtFromChange,
    onCreatedAtToChange,
}: PullRequestsFiltersProps) => {
    const [repoOpen, setRepoOpen] = useState(false);
    const { organizationId } = useAuth();
    const permissions = usePermissions();

    const { data: allRepositories = [] } = useGetSelectedRepositories(teamId);

    const repositories = useMemo(() => {
        if (!organizationId || !Array.isArray(allRepositories)) {
            return [];
        }
        return allRepositories.filter((repo) =>
            hasPermission({
                permissions,
                organizationId,
                action: Action.Read,
                resource: ResourceType.PullRequests,
                repoId: String(repo.id),
            }),
        );
    }, [allRepositories, organizationId, permissions]);

    return (
        <>
            {/* Repository — searchable, since a team can have many repos. */}
            <Popover open={repoOpen} onOpenChange={setRepoOpen}>
                <PopoverTrigger asChild>
                    <Button
                        size="sm"
                        variant="helper"
                        leftIcon={<FolderIcon />}
                        className={cn(
                            "h-9 max-w-[14rem] justify-start gap-1.5 rounded-lg",
                            selectedRepository && "border-primary-light/50",
                        )}>
                        <span className="truncate">
                            {selectedRepository ?? "Any repository"}
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
                                    {!selectedRepository && (
                                        <CheckIcon className="text-primary-light -mr-2 size-5" />
                                    )}
                                </CommandItem>

                                {repositories.map((repo) => (
                                    <CommandItem
                                        key={repo.id}
                                        value={repo.name}
                                        onSelect={() => {
                                            onRepositoryChange(repo.name);
                                            setRepoOpen(false);
                                        }}>
                                        <span className="truncate">
                                            <span className="text-text-secondary">
                                                {repo.organizationName}/
                                            </span>
                                            {repo.name}
                                        </span>
                                        {selectedRepository === repo.name && (
                                            <CheckIcon className="text-primary-light -mr-2 size-5" />
                                        )}
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        </CommandList>
                    </Command>
                </PopoverContent>
            </Popover>

            {/* PR authors — a policy (who counts), not a person list. */}
            <Select
                value={authorPolicy}
                onValueChange={(value) =>
                    onAuthorPolicyChange(value as AuthorPolicyFilterValue)
                }>
                <SelectTrigger
                    size="sm"
                    className={cn(
                        "h-9 w-auto gap-1.5 rounded-lg",
                        authorPolicy !== "reviewable" &&
                            "border-primary-light/50",
                    )}>
                    <SelectValue placeholder="Authors" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="reviewable">
                        Actionable authors
                    </SelectItem>
                    <SelectItem value="all">All authors</SelectItem>
                    <SelectItem value="excluded">Excluded authors</SelectItem>
                </SelectContent>
            </Select>

            {/* Kody suggestions presence. */}
            <Select
                value={suggestionsFilter}
                onValueChange={(value) =>
                    onSuggestionsFilterChange(value as SuggestionsFilterValue)
                }>
                <SelectTrigger
                    size="sm"
                    className={cn(
                        "h-9 w-auto gap-1.5 rounded-lg",
                        suggestionsFilter !== "all" &&
                            "border-primary-light/50",
                    )}>
                    <SelectValue placeholder="Suggestions" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">Any suggestions</SelectItem>
                    <SelectItem value="true">Has suggestions</SelectItem>
                    <SelectItem value="false">No suggestions</SelectItem>
                </SelectContent>
            </Select>

            {/* Review-date range — same calendar the cockpit/token-usage use. */}
            <PullRequestsDateRange
                from={createdAtFrom}
                to={createdAtTo}
                onChange={(from, to) => {
                    onCreatedAtFromChange(from ?? "");
                    onCreatedAtToChange(to ?? "");
                }}
            />
        </>
    );
};
