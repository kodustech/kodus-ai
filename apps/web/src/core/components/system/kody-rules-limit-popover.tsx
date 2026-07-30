"use client";

import { Popover, PopoverContent } from "@components/ui/popover";
import { captureGateHit } from "src/core/utils/gate-hit";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import { GateCtaLink } from "./gate-cta-link";

export const KodyRulesLimitPopover = ({
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
                        feature: "kody_rules",
                        plan: subscription.status,
                        metadata: { surface: "limit_popover", limit },
                    });
            }}>
            {children}

            <PopoverContent
                align="end"
                side="bottom"
                collisionPadding={32}
                className="flex flex-col gap-3 text-sm">
                <p>
                    You've hit the Free plan cap of{" "}
                    <span className="text-primary-light font-semibold">
                        {limit} Kody Rules
                    </span>
                    .
                </p>

                <p>
                    Teams unlocks{" "}
                    <span className="text-primary-light font-semibold">
                        unlimited rules across all your repos
                    </span>
                    , plus unlimited plugins and the Cockpit engineering
                    metrics.
                </p>

                <GateCtaLink
                    feature="kody_rules"
                    plan={subscription.status}
                    metadata={{ surface: "limit_popover", limit }}
                    size="xs"
                    className="mt-2 self-end"
                />
            </PopoverContent>
        </Popover>
    );
};
