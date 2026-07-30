"use client";

import { Popover, PopoverContent } from "@components/ui/popover";
import { captureGateHit } from "src/core/utils/gate-hit";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import { GateCtaLink } from "./gate-cta-link";

export const MCPPluginsLimitPopover = ({
    children,
    limit,
}: {
    limit: number;
    children: React.ReactNode;
}) => {
    const subscription = useSubscriptionStatus();

    return (
        <Popover
            onOpenChange={(open) => {
                if (open)
                    captureGateHit({
                        feature: "mcp_plugins",
                        plan: subscription.status,
                        metadata: { surface: "install_limit_popover", limit },
                    });
            }}>
            {children}

            <PopoverContent
                align="end"
                side="bottom"
                collisionPadding={32}
                className="flex flex-col gap-3 text-sm">
                <p>
                    The Free plan runs{" "}
                    <span className="text-primary-light font-semibold">
                        {limit} plugins
                    </span>{" "}
                    at a time — this one would stay locked.
                </p>

                <p>
                    Teams runs{" "}
                    <span className="text-primary-light font-semibold">
                        unlimited plugins
                    </span>{" "}
                    across all your repos, plus unlimited Kody Rules and the
                    Cockpit engineering metrics.
                </p>

                <GateCtaLink
                    feature="mcp_plugins"
                    plan={subscription.status}
                    metadata={{ surface: "install_limit_popover", limit }}
                    size="xs"
                    className="mt-2 self-end"
                />
            </PopoverContent>
        </Popover>
    );
};
