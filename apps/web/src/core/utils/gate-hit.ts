"use server";

import { auth } from "src/core/config/auth";

import { capturePostHogEvent } from "./posthog";

export type GateFeature =
    | "cockpit"
    | "mcp_plugins"
    | "kody_rules"
    | "linked_repositories"
    | "sso"
    | "activity_logs";

/**
 * Where the gate was met. Kept as a closed union rather than a free string
 * so `gate_id` stays a usable funnel key — one typo and a surface silently
 * becomes its own series nobody notices for a month.
 */
export type GateSurface =
    | "locked_preview"
    | "locked_rules_list"
    | "locked_rules_banner"
    | "locked_banner"
    | "limit_popover"
    | "install_limit_popover"
    | "settings_general";

type GateEventInput = {
    feature: GateFeature;
    surface?: GateSurface;
    /**
     * The plan the org is on (`free_byok`, `teams_byok`, …) and the state
     * billing reports for it (`active`, `trial`, `canceled`, `no-license`).
     * They were one property until now, and "active" meant both a Free org
     * and a paying one — which made every gate number unreadable without
     * going to the billing database.
     */
    planType?: string;
    subscriptionStatus?: string;
    metadata?: Record<string, unknown>;
};

async function captureGateEvent(
    event: "gate_hit" | "gate_cta_click",
    input: GateEventInput,
) {
    try {
        const session = await auth();
        // Session user is the JWT payload (see auth.ts session callback);
        // the next-auth User type isn't augmented with it.
        const user = session?.user as
            { userId?: string; organizationId?: string } | undefined;
        if (!user?.userId) return;

        await capturePostHogEvent({
            userId: user.userId,
            event,
            properties: {
                feature: input.feature,
                surface: input.surface,
                gateId: input.surface
                    ? `${input.feature}.${input.surface}`
                    : input.feature,
                planType: input.planType,
                subscriptionStatus: input.subscriptionStatus,
                // Kept under its original name so the series that has been
                // running since July stays continuous.
                plan: input.subscriptionStatus,
                organizationId: user.organizationId,
                ...input.metadata,
            },
            groups: { organization: user.organizationId },
        });
    } catch {
        // ignore: telemetry only
    }
}

/**
 * Records that a user ran into a plan gate (locked screen, locked card,
 * limit popover). One event per gate surface so we can measure which
 * gate actually drives upgrades. Never throws — telemetry must not
 * break the gated UX.
 */
export async function captureGateHit(input: GateEventInput) {
    return captureGateEvent("gate_hit", input);
}

/**
 * Records a click on a gate's "Upgrade plan" CTA. Paired with
 * `captureGateHit` (fired when the gate is shown) so the view→click rate
 * per gate surface is measurable — `gate_hit` alone only tells us someone
 * saw a lock, not whether it drove any action.
 */
export async function captureGateCtaClick(input: GateEventInput) {
    return captureGateEvent("gate_cta_click", input);
}

/**
 * The step between clicking a plan CTA and the plan actually changing:
 * a Stripe Checkout session was created and the browser is being sent to
 * it. Everything after this point happens on Stripe's pages and comes back
 * to us as a billing webhook (`plan_changed`), so without this event the
 * funnel has a hole exactly where people drop.
 */
export async function captureCheckoutStarted(input: {
    planId: string;
    quantity?: number;
    /** What the org was on before, so upgrades and downgrades differ. */
    planTypeBefore?: string;
    kind?: "subscription" | "credits";
    amountUsd?: number;
}) {
    try {
        const session = await auth();
        const user = session?.user as
            { userId?: string; organizationId?: string } | undefined;
        if (!user?.userId) return;

        await capturePostHogEvent({
            userId: user.userId,
            event: "checkout_started",
            properties: {
                planId: input.planId,
                quantity: input.quantity,
                planTypeBefore: input.planTypeBefore,
                kind: input.kind ?? "subscription",
                amountUsd: input.amountUsd,
                organizationId: user.organizationId,
            },
            groups: { organization: user.organizationId },
        });
    } catch {
        // ignore: telemetry only
    }
}
