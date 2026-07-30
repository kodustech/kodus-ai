"use client";

import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { ArrowRightIcon } from "lucide-react";
import type { GateFeature } from "src/core/utils/gate-hit";
import { captureGateCtaClick } from "src/core/utils/gate-hit";

/**
 * The "Upgrade plan" CTA every gate surface (Cockpit overlay, Plugins/Kody
 * Rules locked banners, both limit popovers) renders. Centralizing it means
 * every gate's click is tracked the same way — without this, `gate_hit`
 * only tells us someone saw a lock, never whether it drove a click.
 */
export const GateCtaLink = ({
    feature,
    plan,
    metadata,
    href = "/settings/subscription",
    label = "Upgrade plan",
    size = "md",
    className,
}: {
    feature: GateFeature;
    plan?: string;
    metadata?: Record<string, unknown>;
    href?: string;
    label?: string;
    size?: React.ComponentProps<typeof Button>["size"];
    className?: string;
}) => {
    return (
        <Link href={href} className={className}>
            <Button
                decorative
                size={size}
                variant="primary"
                rightIcon={<ArrowRightIcon />}
                onClick={() =>
                    captureGateCtaClick({ feature, plan, metadata })
                }>
                {label}
            </Button>
        </Link>
    );
};
