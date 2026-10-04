"use server";

import { captureCheckoutStarted } from "src/core/utils/gate-hit";

import { createCheckoutSession } from "../_services/billing/fetch";

export const createCheckoutSessionAction = async ({
    teamId,
    planId,
    quantity,
    planTypeBefore,
}: {
    teamId: string;
    planId: string;
    quantity: number;
    /** The plan the org is leaving, so upgrades and downgrades differ. */
    planTypeBefore?: string;
}) => {
    try {
        const { url } = await createCheckoutSession({
            teamId,
            quantity,
            planId,
        });

        // Everything after this happens on Stripe and comes back as the
        // `plan_changed` webhook, so this is the last thing we see before
        // people drop out of the funnel.
        captureCheckoutStarted({ planId, quantity, planTypeBefore });

        return { url };
    } catch (error) {
        console.error("Failed to create checkout session:", error);
        throw new Error("Failed to create checkout session");
    }
};
