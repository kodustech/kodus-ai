"use client";

import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { ArrowRightIcon } from "lucide-react";
import {
    captureGateCtaClick,
    type GateFeature,
    type GateSurface,
} from "src/core/utils/gate-hit";

/**
 * The "Upgrade plan" CTA every gate surface (Cockpit overlay, Plugins/Kody
 * Rules locked banners, both limit popovers) renders. Centralizing it means
 * every gate's click is tracked the same way — without this, `gate_hit`
 * only tells us someone saw a lock, never whether it drove a click.
 */
export const GateCtaLink = ({
    feature,
    surface,
    planType,
    subscriptionStatus,
    metadata,
    href = "/settings/subscription",
    label = "Upgrade plan",
    size = "md",
    variant = "primary",
    className,
    buttonClassName,
}: {
    feature: GateFeature;
    surface?: GateSurface;
    planType?: string;
    subscriptionStatus?: string;
    metadata?: Record<string, unknown>;
    href?: string;
    label?: string;
    size?: React.ComponentProps<typeof Button>["size"];
    /** `primary` for banners and overlays; `cancel` reads as an inline link. */
    variant?: React.ComponentProps<typeof Button>["variant"];
    /** Wraps the link; use `buttonClassName` to style the button itself. */
    className?: string;
    buttonClassName?: string;
}) => {
    return (
        <Link href={href} className={className}>
            <Button
                decorative
                size={size}
                variant={variant}
                className={buttonClassName}
                rightIcon={<ArrowRightIcon />}
                onClick={() =>
                    captureGateCtaClick({
                        feature,
                        surface,
                        planType,
                        subscriptionStatus,
                        metadata,
                    })
                }>
                {label}
            </Button>
        </Link>
    );
};
