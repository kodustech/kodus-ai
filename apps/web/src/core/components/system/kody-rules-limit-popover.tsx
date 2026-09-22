"use client";

import { Popover, PopoverContent } from "@components/ui/popover";
import { captureGateHit } from "src/core/utils/gate-hit";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import { GateCtaLink } from "./gate-cta-link";

/**
 * What a "Locked" badge on a Kody Rule opens.
 *
 * It names the rule it hangs off (`ruleTitle`) rather than talking about the
 * cap in the abstract: the reader wrote that rule and expects it to run, and
 * the gap between "saved" and "running" is the whole argument for upgrading.
 * Without a title it falls back to the plain cap explanation.
 */
export const KodyRulesLimitPopover = ({
    children,
    limit,
    ruleTitle,
}: {
    limit: number;
    ruleTitle?: string;
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
                className="flex max-w-xs flex-col gap-3 text-sm">
                {ruleTitle ? (
                    <p>
                        <span className="font-semibold">{ruleTitle}</span> is
                        saved, but Kody does not apply it: the Free plan runs{" "}
                        <span className="text-primary-light font-semibold">
                            {limit} active rules
                        </span>{" "}
                        and this one is over the cap.
                    </p>
                ) : (
                    <p>
                        You've hit the Free plan cap of{" "}
                        <span className="text-primary-light font-semibold">
                            {limit} Kody Rules
                        </span>
                        .
                    </p>
                )}

                <p>
                    Teams runs{" "}
                    <span className="text-primary-light font-semibold">
                        every rule you write
                    </span>
                    , across all your repos — plus unlimited plugins and the
                    Cockpit engineering metrics.
                </p>

                <GateCtaLink
                    feature="kody_rules"
                    plan={subscription.status}
                    metadata={{ surface: "limit_popover", limit }}
                    href="/choose-plan"
                    label="See plans"
                    size="xs"
                    className="mt-2 self-end"
                />
            </PopoverContent>
        </Popover>
    );
};
