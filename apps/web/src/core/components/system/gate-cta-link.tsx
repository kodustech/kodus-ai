"use client";

import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { ArrowRightIcon } from "lucide-react";
import { cn } from "src/core/utils/components";
import {
    captureGateCtaClick,
    type GateFeature,
    type GateSurface,
} from "src/core/utils/gate-hit";
import { isSelfHosted } from "src/core/utils/self-hosted";

// Where plans are bought and license keys pasted (permissions.routes.ts
// gates both on Billing).
const BILLING_ROUTES = ["/choose-plan", "/settings/subscription"];

const leadsToBilling = (href: string) =>
    BILLING_ROUTES.some(
        (route) =>
            href === route ||
            href.startsWith(`${route}/`) ||
            href.startsWith(`${route}?`),
    );

/**
 * Whether a gate may offer a link to `href`: plans and the license key live
 * behind Billing, so a viewer without it would only reach "You don't have
 * access to Billing & Subscription".
 */
export const useCanFollowGateLink = (href: string) => {
    const canOpenBilling = usePermission(Action.Read, ResourceType.Billing);
    return canOpenBilling || !leadsToBilling(href);
};

/**
 * A gate's other way forward (e.g. "Connect a repository"), held to the same
 * rule as the CTA: a target the viewer cannot open is not offered. Not
 * tracked as a plan click.
 */
export const GateAltLink = ({
    href,
    label,
}: {
    href: string;
    label: string;
}) => {
    if (!useCanFollowGateLink(href)) return null;

    return (
        <Link href={href}>
            <Button decorative size="md" variant="primary">
                {label}
            </Button>
        </Link>
    );
};

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
    // A contributor or repo admin can see a locked feature but not the page
    // that unlocks it: the button only led to "You don't have access to
    // Billing & Subscription". Tell them who can act instead.
    if (!useCanFollowGateLink(href)) {
        return (
            <p
                className={cn(
                    "text-text-secondary text-sm text-pretty",
                    className,
                )}>
                {isSelfHosted
                    ? "Ask an organization admin to activate a license."
                    : "Ask an organization admin to upgrade the plan."}
            </p>
        );
    }

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
