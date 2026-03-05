"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { Link } from "@components/ui/link";
import { SidebarMenuSub, SidebarMenuSubItem } from "@components/ui/sidebar";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { cn } from "src/core/utils/components";

import { useCodeReviewRouteParams } from "../../_hooks";
import { countConfigOverrides } from "../../_utils/count-overrides";
import {
    FormattedConfigLevel,
    type CodeReviewRepositoryConfig,
    type FormattedCodeReviewConfig,
} from "../../code-review/_types";
import { SidebarRepositoryOrDirectoryDropdown } from "./options-dropdown";

export const PerDirectory = ({
    routes,
    directory,
    repository,
    configs,
}: {
    repository: Pick<CodeReviewRepositoryConfig, "id" | "name" | "isSelected">;
    directory: Pick<
        NonNullable<CodeReviewRepositoryConfig["directories"]>[number],
        "id" | "name" | "path"
    >;
    routes: Array<{ label: string; href: string }>;
    configs?: FormattedCodeReviewConfig;
}) => {
    const searchParams = useSearchParams();
    const { repositoryId, pageName, directoryId } = useCodeReviewRouteParams();
    const [open, setOpen] = useState(directoryId === directory.id);

    const overrideCount = configs
        ? countConfigOverrides(configs, FormattedConfigLevel.DIRECTORY)
        : 0;

    return (
        <Collapsible
            open={open}
            onOpenChange={setOpen}
            className="[li+div]:mt-2">
            <div className="flex items-center justify-between gap-2">
                <Tooltip disableHoverableContent>
                    <CollapsibleTrigger asChild>
                        <TooltipTrigger asChild>
                            <Button
                                size="md"
                                variant="helper"
                                className="h-fit flex-1 justify-start py-2"
                                leftIcon={
                                    <CollapsibleIndicator
                                        className={cn(
                                            "-ml-1",
                                            open ? "rotate-0!" : "-rotate-90!",
                                        )}
                                    />
                                }
                                rightIcon={
                                    overrideCount > 0 && (
                                        <Badge
                                            variant="primary-dark"
                                            className="h-5 min-w-5 rounded-full px-1.5 text-[10px] font-medium">
                                            {overrideCount}
                                        </Badge>
                                    )
                                }>
                                <span className="line-clamp-1 truncate text-ellipsis">
                                    {directory.path}
                                </span>
                            </Button>
                        </TooltipTrigger>
                    </CollapsibleTrigger>

                    <TooltipContent side="right" className="text-sm">
                        {directory.path}
                        {overrideCount > 0 && (
                            <div className="text-text-tertiary mt-1 text-xs">
                                {overrideCount} config
                                {overrideCount !== 1 ? "s" : ""} overridden
                            </div>
                        )}
                    </TooltipContent>
                </Tooltip>

                <SidebarRepositoryOrDirectoryDropdown
                    repository={repository}
                    directory={directory}
                />
            </div>

            <CollapsibleContent>
                <SidebarMenuSub>
                    {routes.map(({ label, href }) => {
                        const active =
                            repositoryId === repository.id &&
                            pageName === href &&
                            searchParams.get("directoryId") === directory.id;

                        return (
                            <SidebarMenuSubItem key={href}>
                                <Link
                                    className="w-full"
                                    href={`/settings/code-review/${repository.id}/${href}?directoryId=${directory.id}`}>
                                    <Button
                                        size="sm"
                                        decorative
                                        variant="cancel"
                                        active={active}
                                        className="min-h-auto w-full justify-start px-0 py-2">
                                        {label}
                                    </Button>
                                </Link>
                            </SidebarMenuSubItem>
                        );
                    })}
                </SidebarMenuSub>
            </CollapsibleContent>
        </Collapsible>
    );
};
