"use client";

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
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
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
import { CheckIcon, ListFilterIcon } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { usePermissions } from "src/core/providers/permissions.provider";
import { hasPermission } from "src/core/utils/permission-map";

type SuggestionsFilterValue = "all" | "true" | "false";
type AuthorPolicyFilterValue = "all" | "reviewable" | "excluded";

interface PullRequestsFiltersProps {
    teamId: string;
    selectedRepository?: string;
    onRepositoryChange: (repoName?: string) => void;
    pullRequestTitle: string;
    onTitleChange: (value: string) => void;
    pullRequestNumber: string;
    onPullRequestNumberChange: (value: string) => void;
    suggestionsFilter: SuggestionsFilterValue;
    onSuggestionsFilterChange: (value: SuggestionsFilterValue) => void;
    authorPolicy: AuthorPolicyFilterValue;
    onAuthorPolicyChange: (value: AuthorPolicyFilterValue) => void;
}

export const PullRequestsFilters = ({
    teamId,
    selectedRepository,
    onRepositoryChange,
    pullRequestTitle,
    onTitleChange,
    pullRequestNumber,
    onPullRequestNumberChange,
    suggestionsFilter,
    onSuggestionsFilterChange,
    authorPolicy,
    onAuthorPolicyChange,
}: PullRequestsFiltersProps) => {
    const [open, setOpen] = useState(false);
    const [mounted, setMounted] = useState(false);
    const { organizationId } = useAuth();
    const permissions = usePermissions();

    const { data: allRepositories = [], isLoading } =
        useGetSelectedRepositories(teamId);

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

    const appliedFiltersCount =
        (pullRequestTitle.trim().length > 0 ? 1 : 0) +
        (pullRequestNumber?.trim().length > 0 ? 1 : 0) +
        (suggestionsFilter !== "all" ? 1 : 0) +
        (authorPolicy !== "reviewable" ? 1 : 0) +
        (selectedRepository ? 1 : 0);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) {
        return (
            <Button
                size="xs"
                variant="helper"
                loading={isLoading}
                leftIcon={<ListFilterIcon />}>
                Filters
                {appliedFiltersCount > 0 && (
                    <span className="text-text-secondary">
                        {` (${appliedFiltersCount})`}
                    </span>
                )}
            </Button>
        );
    }

    return (
        <Popover open={open} onOpenChange={setOpen} modal>
            <PopoverTrigger asChild>
                <Button
                    size="xs"
                    variant="helper"
                    loading={isLoading}
                    leftIcon={<ListFilterIcon />}>
                    Filters
                    {appliedFiltersCount > 0 && (
                        <span className="text-text-secondary">
                            {` (${appliedFiltersCount})`}
                        </span>
                    )}
                </Button>
            </PopoverTrigger>

            <PopoverContent
                align="end"
                sideOffset={10}
                className="flex w-96 flex-col gap-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <ListFilterIcon className="size-4" />
                        <Label>Filters</Label>
                    </div>

                    <Button
                        size="xs"
                        variant="cancel"
                        onClick={() => {
                            onRepositoryChange(undefined);
                            onTitleChange("");
                            onPullRequestNumberChange("");
                            onSuggestionsFilterChange("all");
                            onAuthorPolicyChange("reviewable");
                        }}>
                        Clear
                    </Button>
                </div>

                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                        <Label className="text-text-secondary text-xs">
                            PR title
                        </Label>
                        <Input
                            size="md"
                            placeholder="Title contains..."
                            value={pullRequestTitle}
                            onChange={(event) =>
                                onTitleChange(event.target.value)
                            }
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <Label className="text-text-secondary text-xs">
                            PR number
                        </Label>
                        <Input
                            size="md"
                            placeholder="PR number..."
                            value={pullRequestNumber}
                            onChange={(event) =>
                                onPullRequestNumberChange(event.target.value)
                            }
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <Label className="text-text-secondary text-xs">
                            Kody suggestions
                        </Label>
                        <Select
                            value={suggestionsFilter}
                            onValueChange={(value) =>
                                onSuggestionsFilterChange(
                                    value as SuggestionsFilterValue,
                                )
                            }>
                            <SelectTrigger size="md">
                                <SelectValue placeholder="Suggestions" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">
                                    Any (default)
                                </SelectItem>
                                <SelectItem value="true">
                                    Has suggestions
                                </SelectItem>
                                <SelectItem value="false">
                                    No suggestions
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <Label className="text-text-secondary text-xs">
                            PR authors
                        </Label>
                        <Select
                            value={authorPolicy}
                            onValueChange={(value) =>
                                onAuthorPolicyChange(
                                    value as AuthorPolicyFilterValue,
                                )
                            }>
                            <SelectTrigger size="md">
                                <SelectValue placeholder="Author policy" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="reviewable">
                                    Actionable only (default)
                                </SelectItem>
                                <SelectItem value="all">
                                    All PR authors
                                </SelectItem>
                                <SelectItem value="excluded">
                                    Excluded by policy only
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <Label className="text-text-secondary text-xs uppercase">
                            Repositories
                        </Label>
                        <Command>
                            <CommandInput placeholder="Search repositories..." />
                            <CommandList className="max-h-48 overflow-y-auto">
                                <CommandEmpty>
                                    No repository found.
                                </CommandEmpty>
                                <CommandGroup>
                                    <CommandItem
                                        value="all"
                                        onSelect={() => {
                                            onRepositoryChange(undefined);
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
                                            }}>
                                            <span>
                                                <span className="text-text-secondary">
                                                    {repo.organizationName}/
                                                </span>
                                                {repo.name}
                                            </span>
                                            {selectedRepository ===
                                                repo.name && (
                                                <CheckIcon className="text-primary-light -mr-2 size-5" />
                                            )}
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            </CommandList>
                        </Command>
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
};
