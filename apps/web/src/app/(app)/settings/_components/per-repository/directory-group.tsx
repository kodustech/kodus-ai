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
import { FolderIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { useCodeReviewRouteParams } from "../../_hooks";
import { countConfigOverridesForRoutes } from "../../_utils/count-overrides";
import {
    FormattedConfigLevel,
    type CodeReviewRepositoryConfig,
    type DirectoryFolder,
    type FormattedCodeReviewConfig,
} from "../../code-review/_types";
import { RouteButtonWithOverrideCount } from "../route-button-with-override-count";
import { SidebarRepositoryOrDirectoryDropdown } from "./options-dropdown";

export const PerDirectoryGroup = ({
    routes,
    group,
    repository,
    configs,
    customMessagesOverrideCount,
}: {
    repository: Pick<CodeReviewRepositoryConfig, "id" | "name" | "isSelected">;
    group: {
        id: string;
        name: string;
        folders: DirectoryFolder[];
    };
    routes: Array<{ label: string; href: string }>;
    configs?: FormattedCodeReviewConfig;
    customMessagesOverrideCount?: number;
}) => {
    const searchParams = useSearchParams();
    const { repositoryId, pageName, directoryId } = useCodeReviewRouteParams();
    const [open, setOpen] = useState(directoryId === group.id);

    const configOverrideCount = countConfigOverridesForRoutes(
        configs,
        routes.map((route) => route.href),
        FormattedConfigLevel.DIRECTORY,
    );
    const directoryKodyRulesCount = useKodyRulesCount(
        repository.id,
        group.id,
    );
    const resolvedOverrideCount =
        configOverrideCount +
        (customMessagesOverrideCount ?? 0) +
        directoryKodyRulesCount;

    const folders = group.folders ?? [];
    const primary = folders[0];
    const remaining = folders.length - 1;

    if (!primary) return null;

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
                                className="h-fit flex-1 justify-start py-1.5"
                                leftIcon={
                                    <CollapsibleIndicator
                                        className={cn(
                                            "-ml-1",
                                            open
                                                ? "rotate-0!"
                                                : "-rotate-90!",
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
                                <div className="flex min-w-0 flex-col items-start">
                                    <span
                                        dir="rtl"
                                        className="w-full truncate text-left font-mono text-[11px]">
                                        {primary.path}
                                    </span>
                                    {remaining > 0 && (
                                        <span className="text-text-tertiary text-[10px] font-normal">
                                            +{remaining} other
                                            {remaining > 1 ? "s" : ""}
                                        </span>
                                    )}
                                </div>
                            </Button>
                        </TooltipTrigger>
                    </CollapsibleTrigger>
                    <TooltipContent side="right" className="text-xs">
                        <ul className="list-none space-y-0.5">
                            {folders.map((f) => (
                                <li key={f.id} className="font-mono">
                                    {f.path}
                                </li>
                            ))}
                        </ul>
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
                    directory={group}
                />
            </div>

            <CollapsibleContent>
                <SidebarMenuSub>
                    {/* Folder list (only shown for multi-folder groups) */}
                    {folders.length > 1 && (
                        <div className="border-card-lv3 mb-2 border-b pb-2">
                            {folders.map((f) => (
                                <Tooltip key={f.id} disableHoverableContent>
                                    <TooltipTrigger asChild>
                                        <div className="hover:bg-card-lv2 flex items-center gap-1.5 rounded px-2 py-1 transition-colors">
                                            <FolderIcon className="text-text-tertiary size-3 shrink-0" />
                                            <span
                                                dir="rtl"
                                                className="text-text-secondary min-w-0 truncate text-left font-mono text-[11px]">
                                                {f.path}
                                            </span>
                                        </div>
                                    </TooltipTrigger>
                                    <TooltipContent side="right">
                                        {f.path}
                                    </TooltipContent>
                                </Tooltip>
                            ))}
                        </div>
                    )}

                    {/* Route menu items */}
                    {routes.map(({ label, href }) => {
                        const active =
                            repositoryId === repository.id &&
                            pageName === href &&
                            searchParams.get("directoryId") === group.id;

                        return (
                            <SidebarMenuSubItem key={href}>
                                <RouteButtonWithOverrideCount
                                    label={label}
                                    href={href}
                                    to={`/settings/code-review/${repository.id}/${href}?directoryId=${group.id}`}
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
