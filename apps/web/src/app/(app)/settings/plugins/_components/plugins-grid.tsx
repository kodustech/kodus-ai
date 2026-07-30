"use client";

import { useEffect, useMemo, useRef } from "react";
import { Avatar, AvatarImage } from "@components/ui/avatar";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { GateCtaLink } from "@components/system/gate-cta-link";
import { Link } from "@components/ui/link";
import type { getMCPPlugins } from "@services/mcp-manager/fetch";
import { MCP_CONNECTION_STATUS } from "@services/mcp-manager/types";
import { useMCPPluginsLimit } from "@services/mcp-manager/use-mcp-plugins-limit";
import { CheckIcon, ImageOff, LockIcon } from "lucide-react";
import type { AwaitedReturnType } from "src/core/types";
import { cn } from "src/core/utils/components";
import { captureGateHit } from "src/core/utils/gate-hit";
import {
    computeLockedPluginIds,
    countInstalledPlugins,
} from "src/core/utils/mcp-plugins/compute-locked-plugins";

export const PluginsGrid = ({
    plugins,
    orderedActiveIntegrationIds,
}: {
    plugins: AwaitedReturnType<typeof getMCPPlugins>;
    /** integrationIds of ACTIVE connections, oldest first — the backend
     * runs only the first `limit` of these on capped plans. */
    orderedActiveIntegrationIds: string[];
}) => {
    // Default (system-managed) plugins like "Kodus MCP" are always on and
    // don't count against the plan's plugin cap — they never appear in
    // /mcp/connections at all, so they'd otherwise look "locked" whenever
    // they fall outside the runnable set computed from that list.
    const installedCount = countInstalledPlugins(plugins);
    const { limited, limit, plan } = useMCPPluginsLimit(installedCount);

    const lockedIds = useMemo(
        () =>
            computeLockedPluginIds(
                plugins,
                orderedActiveIntegrationIds,
                limited,
                limit,
            ),
        [limited, limit, plugins, orderedActiveIntegrationIds],
    );

    const gateReported = useRef(false);
    useEffect(() => {
        if (lockedIds.size === 0 || gateReported.current) return;
        gateReported.current = true;
        captureGateHit({
            feature: "mcp_plugins",
            plan,
            metadata: { lockedCount: lockedIds.size, installedCount },
        });
    }, [lockedIds.size, plan, installedCount]);

    return (
        <div className="flex flex-col gap-4">
            {lockedIds.size > 0 && (
                <Card
                    color="lv1"
                    className="flex flex-row items-center justify-between gap-6 p-5">
                    <div className="flex flex-col gap-1">
                        <span className="text-text-primary text-sm font-semibold">
                            {lockedIds.size} of your plugins{" "}
                            {lockedIds.size === 1 ? "is" : "are"} locked
                        </span>
                        <span className="text-text-secondary text-sm">
                            The Free plan runs {limit} plugins at a time —
                            locked plugins are skipped during reviews. Upgrade
                            to run them all, plus unlimited Kody Rules and the
                            Cockpit.
                        </span>
                    </div>
                    <GateCtaLink
                        feature="mcp_plugins"
                        plan={plan}
                        metadata={{
                            surface: "locked_banner",
                            lockedCount: lockedIds.size,
                        }}
                        size="sm"
                        className="shrink-0"
                    />
                </Card>
            )}

            <div className="grid grid-cols-2 gap-2">
                {plugins.map((item) => {
                    const isLocked = lockedIds.has(item.id);

                    return (
                        <Link
                            key={item.id}
                            className="w-full"
                            href={`/settings/plugins/${item.provider}/${item.id}`}>
                            <Button
                                size="lg"
                                decorative
                                variant="helper"
                                className="h-full w-full items-start gap-0 px-0 py-0">
                                <Card className="flex w-full gap-0 bg-transparent shadow-none">
                                    <CardHeader className="gap-4">
                                        <div
                                            className={cn(
                                                "flex h-fit flex-row items-center gap-5",
                                                isLocked && "opacity-60",
                                            )}>
                                            <Avatar className="bg-card-lv3 group-disabled/link:bg-card-lv3/50 size-10 rounded-lg p-1">
                                                {item.logo ? (
                                                    <AvatarImage
                                                        src={item.logo}
                                                        alt={`${item.appName} logo`}
                                                        className="object-contain"
                                                    />
                                                ) : (
                                                    <ImageOff className="text-text-tertiary m-auto h-6 w-6" />
                                                )}
                                            </Avatar>

                                            <div className="flex-1">
                                                <div className="flex items-center gap-2">
                                                    <CardTitle className="text-text-primary capitalize">
                                                        {item.appName}
                                                    </CardTitle>
                                                    {item.provider ===
                                                        "composio" && (
                                                        <Badge className="bg-red-500/10 text-red-500 border-red-500/20 pointer-events-none text-[10px]">
                                                            Deprecated
                                                        </Badge>
                                                    )}
                                                </div>

                                                <span className="text-text-tertiary text-xs">
                                                    @{item.provider}
                                                </span>
                                            </div>

                                            {isLocked ? (
                                                <Badge
                                                    variant="tertiary"
                                                    leftIcon={<LockIcon />}
                                                    className="pointer-events-none">
                                                    Locked
                                                </Badge>
                                            ) : (
                                                item.isConnected &&
                                                item.connectionStatus ===
                                                    MCP_CONNECTION_STATUS.ACTIVE && (
                                                    <Badge
                                                        variant="tertiary"
                                                        leftIcon={<CheckIcon />}
                                                        className="bg-success! text-card-lv2! pointer-events-none">
                                                        {item.isDefault
                                                            ? "Default"
                                                            : "Installed"}
                                                    </Badge>
                                                )
                                            )}
                                        </div>

                                        {item.description && (
                                            <CardDescription className="text-sm">
                                                {item.description}
                                            </CardDescription>
                                        )}
                                    </CardHeader>
                                </Card>
                            </Button>
                        </Link>
                    );
                })}
            </div>
        </div>
    );
};
