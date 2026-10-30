"use client";

import { Popover, PopoverContent } from "@components/ui/popover";
import { planCtaTarget } from "@components/system/plan-cta-target";
import { captureGateHit } from "src/core/utils/gate-hit";
import { useCapOwnerLabel } from "src/features/ee/subscription/_hooks/use-resource-limits";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import { GateCtaLink } from "./gate-cta-link";

/**
 * What the disabled "Install plugin" button opens once the free-plan cap is
 * full. It names the plugin being installed and the ones already holding the
 * slots, so the trade-off is concrete ("to run this one, stop running that
 * one") instead of a cap stated in the abstract.
 */
export const MCPPluginsLimitPopover = ({
    children,
    limit,
    pluginName,
    running = [],
}: {
    limit: number;
    pluginName?: string;
    /** Plugins currently occupying the free-plan slots. */
    running?: string[];
    children: React.ReactNode;
}) => {
    const subscription = useSubscriptionStatus();
    const capOwner = useCapOwnerLabel();
    // `planType` exists on some members of the status union only (a trial
    // has no plan yet), so it is read defensively.
    const planType =
        "planType" in subscription ? subscription.planType : undefined;
    const runningLabel = running.slice(0, 3).join(", ");

    return (
        <Popover
            onOpenChange={(open) => {
                if (open)
                    captureGateHit({
                        feature: "mcp_plugins",
                        surface: "install_limit_popover",
                        planType,
                        subscriptionStatus: subscription.status,
                        metadata: { limit },
                    });
            }}>
            {children}

            <PopoverContent
                align="end"
                side="bottom"
                collisionPadding={32}
                className="flex max-w-xs flex-col gap-3 text-sm">
                <p>
                    {pluginName ? (
                        <>
                            <span className="font-semibold">{pluginName}</span>{" "}
                            would stay locked: {capOwner} runs{" "}
                        </>
                    ) : (
                        <>This plugin would stay locked — {capOwner} runs </>
                    )}
                    <span className="text-text-primary font-semibold">
                        {limit} plugin{limit === 1 ? "" : "s"}
                    </span>{" "}
                    at a time
                    {runningLabel ? `, and ${runningLabel} ` : " "}
                    {runningLabel
                        ? running.length > 3
                            ? "and others already hold the slots."
                            : `already ${running.length === 1 ? "holds" : "hold"} the slots.`
                        : "during reviews."}
                </p>

                <p>
                    Teams runs{" "}
                    <span className="text-text-primary font-semibold">
                        every plugin you install
                    </span>
                    , across all your repos — plus unlimited Kody Rules and the
                    Cockpit engineering metrics.
                </p>

                <GateCtaLink
                    feature="mcp_plugins"
                    surface="install_limit_popover"
                    planType={planType}
                    subscriptionStatus={subscription.status}
                    metadata={{ limit }}
                    {...planCtaTarget()}
                    size="xs"
                    className="mt-2 self-end"
                />
            </PopoverContent>
        </Popover>
    );
};
