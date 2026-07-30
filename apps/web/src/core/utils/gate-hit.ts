"use server";

import { auth } from "src/core/config/auth";

import { capturePostHogEvent } from "./posthog";

export type GateFeature = "cockpit" | "mcp_plugins" | "kody_rules";

type GateEventInput = {
    feature: GateFeature;
    plan?: string;
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
            | { userId?: string; organizationId?: string }
            | undefined;
        if (!user?.userId) return;

        await capturePostHogEvent({
            userId: user.userId,
            event,
            properties: {
                feature: input.feature,
                plan: input.plan,
                organizationId: user.organizationId,
                ...input.metadata,
            },
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
