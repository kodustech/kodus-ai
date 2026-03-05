"use client";

import { useEffect, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { Link } from "@components/ui/link";
import { magicModal } from "@components/ui/magic-modal";
import {
    SidebarMenuItem,
    SidebarMenuSub,
    SidebarMenuSubItem,
} from "@components/ui/sidebar";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import type { useSuspenseGetParameterPlatformConfigs } from "@services/parameters/hooks";
import { KodyLearningStatus } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { Plus } from "lucide-react";
import { safeArray } from "src/core/utils/safe-array";

import { useCodeReviewRouteParams } from "../../_hooks";
import { countConfigOverrides } from "../../_utils/count-overrides";
import {
    FormattedConfigLevel,
    type FormattedGlobalCodeReviewConfig,
} from "../../code-review/_types";
import { AddRepoModal } from "../copy-settings-modal";
import { PerDirectory } from "./directory";
import { SidebarRepositoryOrDirectoryDropdown } from "./options-dropdown";

export const PerRepository = ({
    configValue,
    routes,
    platformConfig,
}: {
    configValue: FormattedGlobalCodeReviewConfig;
    platformConfig: ReturnType<typeof useSuspenseGetParameterPlatformConfigs>;
    routes: Array<{ label: string; href: string }>;
}) => {
    const { repositoryId, directoryId, pageName } = useCodeReviewRouteParams();
    const canCreate = usePermission(
        Action.Create,
        ResourceType.CodeReviewSettings,
    );

    // Avoid hydration mismatch with Radix Collapsible/Tooltip IDs
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
    }, []);

    return (
        <SidebarMenuItem>
            <div className="pl-2">
                <div className="flex justify-between">
                    <div className="mb-4 flex flex-col gap-0.5">
                        <strong>Per repository</strong>
                        <span className="text-text-secondary text-xs">
                            Set custom configurations for each repository
                            (override global defaults).
                        </span>
                    </div>

                    <Button
                        size="icon-sm"
                        variant="secondary"
                        onClick={() => {
                            magicModal.show(() => (
                                <AddRepoModal
                                    repositories={configValue?.repositories}
                                />
                            ));
                        }}
                        disabled={
                            !canCreate ||
                            platformConfig.configValue.kodyLearningStatus ===
                                KodyLearningStatus.GENERATING_CONFIG
                        }>
                        <Plus />
                    </Button>
                </div>
            </div>

            <div className="flex flex-col gap-1">
                {/* Render Collapsible only after mount to avoid hydration mismatch */}
                {mounted &&
                    safeArray(configValue?.repositories)
                        .filter(
                            (r) =>
                                r.isSelected ||
                                safeArray(r.directories).length > 0,
                        )
                        .map((r) => {
                            const hasRepositoryConfig = r.isSelected;
                            const overrideCount = hasRepositoryConfig
                                ? countConfigOverrides(
                                      r.configs,
                                      FormattedConfigLevel.REPOSITORY,
                                  )
                                : 0;

                            return (
                                <Collapsible
                                    key={r.id}
                                    defaultOpen={repositoryId === r.id}>
                                    <div className="flex items-center justify-between gap-2">
                                        <Tooltip disableHoverableContent>
                                            <CollapsibleTrigger asChild>
                                                <TooltipTrigger asChild>
                                                    <Button
                                                        size="md"
                                                        variant="helper"
                                                        className="h-fit flex-1 justify-start py-2"
                                                        leftIcon={
                                                            <CollapsibleIndicator className="-ml-1 group-data-[state=closed]/collapsible:rotate-[-90deg] group-data-[state=open]/collapsible:rotate-0" />
                                                        }
                                                        rightIcon={
                                                            overrideCount >
                                                                0 && (
                                                                <Badge
                                                                    variant="primary-dark"
                                                                    className="h-5 min-w-5 rounded-full px-1.5 text-[10px] font-medium">
                                                                    {
                                                                        overrideCount
                                                                    }
                                                                </Badge>
                                                            )
                                                        }>
                                                        <span className="line-clamp-1 truncate text-ellipsis">
                                                            {r.name}
                                                        </span>
                                                    </Button>
                                                </TooltipTrigger>
                                            </CollapsibleTrigger>

                                            <TooltipContent
                                                side="right"
                                                className="text-sm">
                                                {r.name}
                                                {overrideCount > 0 && (
                                                    <div className="text-text-tertiary mt-1 text-xs">
                                                        {overrideCount} config
                                                        {overrideCount !== 1
                                                            ? "s"
                                                            : ""}{" "}
                                                        overridden
                                                    </div>
                                                )}
                                            </TooltipContent>
                                        </Tooltip>

                                        {hasRepositoryConfig && (
                                            <SidebarRepositoryOrDirectoryDropdown
                                                repository={r}
                                            />
                                        )}
                                    </div>

                                    <CollapsibleContent>
                                        <SidebarMenuSub>
                                            {hasRepositoryConfig &&
                                                routes.map(
                                                    ({ label, href }) => {
                                                        const active =
                                                            repositoryId ===
                                                                r.id &&
                                                            pageName === href &&
                                                            !directoryId;

                                                        return (
                                                            <SidebarMenuSubItem
                                                                key={label}>
                                                                <Link
                                                                    className="w-full"
                                                                    href={`/settings/code-review/${r.id}/${href}`}>
                                                                    <Button
                                                                        key={
                                                                            label
                                                                        }
                                                                        decorative
                                                                        size="sm"
                                                                        variant="cancel"
                                                                        active={
                                                                            active
                                                                        }
                                                                        className="min-h-auto w-full justify-start px-0 py-2">
                                                                        {label}
                                                                    </Button>
                                                                </Link>
                                                            </SidebarMenuSubItem>
                                                        );
                                                    },
                                                )}

                                            {r.directories?.map((d) => {
                                                const directoryWithConfigs =
                                                    configValue.repositories
                                                        .find(
                                                            (repo) =>
                                                                repo.id ===
                                                                r.id,
                                                        )
                                                        ?.directories?.find(
                                                            (dir) =>
                                                                dir.id === d.id,
                                                        );

                                                return (
                                                    <PerDirectory
                                                        key={d.id}
                                                        directory={d}
                                                        repository={r}
                                                        routes={routes}
                                                        configs={
                                                            directoryWithConfigs?.configs
                                                        }
                                                    />
                                                );
                                            })}
                                        </SidebarMenuSub>
                                    </CollapsibleContent>
                                </Collapsible>
                            );
                        })}
            </div>
        </SidebarMenuItem>
    );
};
