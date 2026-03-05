"use client";

import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { Filter, SearchIcon } from "lucide-react";

type Repository = {
    id: string;
    name: string;
};

type KodyRulesToolbarProps = {
    filterQuery: string;
    onFilterQueryChange: (query: string) => void;
    isDisabled: boolean;
    entityLabel?: "rules" | "memories";
} & FilterPopoverContentProps;

export const KodyRulesToolbar = ({
    filterQuery,
    onFilterQueryChange,
    isDisabled,
    entityLabel = "rules",
    visibleScopes,
    onVisibleScopesChange,
    isRepoView,
    isGlobalView,
}: KodyRulesToolbarProps) => {
    return (
        <div className="flex items-center gap-2">
            <Input
                size="md"
                value={filterQuery}
                leftIcon={<SearchIcon />}
                onChange={(e) => onFilterQueryChange(e.target.value)}
                placeholder={
                    entityLabel === "memories"
                        ? "Search for titles or instructions"
                        : "Search for titles, paths or instructions"
                }
                disabled={isDisabled}
                className="grow"
            />
            <Popover>
                <PopoverTrigger asChild>
                    <Button
                        size="md"
                        variant="secondary"
                        decorative
                        leftIcon={<Filter />}>
                        Filters
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80" align="end">
                    <FilterPopoverContent
                        visibleScopes={visibleScopes}
                        onVisibleScopesChange={onVisibleScopesChange}
                        isRepoView={isRepoView}
                        isGlobalView={isGlobalView}
                    />
                </PopoverContent>
            </Popover>
        </div>
    );
};

export type VisibleScopes = {
    self: boolean;
    dir: boolean;
    repo: boolean;
    global: boolean;
    disabled: boolean;
};

type FilterPopoverContentProps = {
    visibleScopes: VisibleScopes;
    onVisibleScopesChange: (scopes: VisibleScopes) => void;
    isRepoView: boolean; // Viewing a repository (not a directory within it)
    isGlobalView: boolean; // Viewing the global config
    entityLabel?: "rules" | "memories";
};

export const FilterPopoverContent = ({
    visibleScopes,
    onVisibleScopesChange,
    isRepoView,
    isGlobalView,
    entityLabel = "rules",
}: FilterPopoverContentProps) => {
    if (isGlobalView) {
        return (
            <p className="text-text-secondary text-sm">
                Global {entityLabel} do not inherit from other scopes.
            </p>
        );
    }

    const handleScopeChange = (
        scope: keyof VisibleScopes,
        checked: boolean,
    ) => {
        onVisibleScopesChange({ ...visibleScopes, [scope]: checked });
    };

    const isDirectoryView = !isRepoView && !isGlobalView;

    return (
        <div className="grid gap-4 p-1">
            <div className="space-y-1">
                <h4 className="text-sm leading-none font-medium">
                    View Options
                </h4>
                <p className="text-text-secondary text-sm">
                    Show or hide {entityLabel} from different scopes.
                </p>
            </div>
            <div className="grid gap-2">
                <div className="flex items-center space-x-2">
                    <Checkbox
                        id="scope-self"
                        checked={visibleScopes.self}
                        onCheckedChange={(checked) =>
                            handleScopeChange("self", Boolean(checked))
                        }
                    />
                    <Label htmlFor="scope-self">
                        {isRepoView ? "Repository Rules" : "Directory Rules"}
                    </Label>
                </div>

                {isDirectoryView && (
                    <div className="flex items-center space-x-2">
                        <Checkbox
                            id="scope-dir"
                            checked={visibleScopes.dir}
                            onCheckedChange={(checked) =>
                                handleScopeChange("dir", Boolean(checked))
                            }
                        />
                        <Label htmlFor="scope-dir">
                            Inherited from other Directories
                        </Label>
                    </div>
                )}

                {isDirectoryView && (
                    <div className="flex items-center space-x-2">
                        <Checkbox
                            id="scope-repo"
                            checked={visibleScopes.repo}
                            onCheckedChange={(checked) =>
                                handleScopeChange("repo", Boolean(checked))
                            }
                        />
                        <Label htmlFor="scope-repo">
                            Inherited from Repository
                        </Label>
                    </div>
                )}

                <div className="flex items-center space-x-2">
                    <Checkbox
                        id="scope-global"
                        checked={visibleScopes.global}
                        onCheckedChange={(checked) =>
                            handleScopeChange("global", Boolean(checked))
                        }
                    />
                    <Label htmlFor="scope-global">Inherited from Global</Label>
                </div>

                <div className="flex items-center space-x-2">
                    <Checkbox
                        id="scope-disabled"
                        checked={visibleScopes.disabled}
                        onCheckedChange={(checked) =>
                            handleScopeChange("disabled", Boolean(checked))
                        }
                    />
                    <Label htmlFor="scope-disabled">Disabled Rules</Label>
                </div>
            </div>
        </div>
    );
};
