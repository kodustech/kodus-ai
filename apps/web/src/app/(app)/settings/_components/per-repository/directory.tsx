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
import { SidebarMenuSub, SidebarMenuSubItem } from "@components/ui/sidebar";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useKodyRulesCount } from "@services/kodyRules/hooks";
import { cn } from "src/core/utils/components";

import { useCodeReviewRouteParams } from "../../_hooks";
import { countConfigOverridesForRoutes } from "../../_utils/count-overrides";
import {
    FormattedConfigLevel,
    type CodeReviewRepositoryConfig,
    type FormattedCodeReviewConfig,
} from "../../code-review/_types";
import { RouteButtonWithOverrideCount } from "../route-button-with-override-count";
import { SidebarRepositoryOrDirectoryDropdown } from "./options-dropdown";

export const PerDirectory = ({
    routes,
    directory,
    repository,
    configs,
    customMessagesOverrideCount,
}: {
    repository: Pick<CodeReviewRepositoryConfig, "id" | "name" | "isSelected">;
    directory: Pick<
        NonNullable<CodeReviewRepositoryConfig["directories"]>[number],
        "id" | "name" | "path"
    >;
    routes: Array<{ label: string; href: string }>;
    configs?: FormattedCodeReviewConfig;
    customMessagesOverrideCount?: number;
}) => {
    const searchParams = useSearchParams();
    const { repositoryId, pageName, directoryId } = useCodeReviewRouteParams();
    const [open, setOpen] = useState(directoryId === directory.id);
    const configOverrideCount = countConfigOverridesForRoutes(
        configs,
        routes.map((route) => route.href),
        FormattedConfigLevel.DIRECTORY,
    );
    const directoryKodyRulesCount = useKodyRulesCount(
        repository.id,
        directory.id,
    );
    const resolvedOverrideCount =
        configOverrideCount +
        (customMessagesOverrideCount ?? 0) +
        directoryKodyRulesCount;

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
                                    resolvedOverrideCount > 0 && (
                                        <Badge
                                            variant="primary-dark"
                                            className="h-5 min-w-5 rounded-full px-1.5 text-[10px] font-medium">
                                            {resolvedOverrideCount}
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
                        {resolvedOverrideCount > 0 && (
                            <div className="text-text-tertiary mt-1 text-xs">
                                {resolvedOverrideCount} config
                                {resolvedOverrideCount !== 1 ? "s" : ""}{" "}
                                overridden
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
                                <RouteButtonWithOverrideCount
                                    label={label}
                                    href={href}
                                    to={`/settings/code-review/${repository.id}/${href}?directoryId=${directory.id}`}
                                    active={active}
                                    level={FormattedConfigLevel.DIRECTORY}
                                    config={configs}
                                    customMessagesOverrideCount={
                                        customMessagesOverrideCount ?? 0
                                    }
                                    kodyRulesOverrideCount={
                                        directoryKodyRulesCount
                                    }
                                />
                            </SidebarMenuSubItem>
                        );
                    })}
                </SidebarMenuSub>
            </CollapsibleContent>
        </Collapsible>
    );
};
