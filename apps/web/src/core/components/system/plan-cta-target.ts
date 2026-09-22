import { isSelfHosted } from "src/core/utils/self-hosted";

/**
 * Where a locked feature's CTA should send someone, and what to call it.
 *
 * A self-hosted install has no Stripe and no plan chooser: capability
 * comes from a license key pasted on the subscription page. Sending that
 * operator to `/choose-plan` — as every gate did — lands them on a screen
 * built entirely around a checkout they cannot reach.
 */
export const planCtaTarget = (): { href: string; label: string } =>
    isSelfHosted
        ? { href: "/settings/subscription", label: "Activate a license" }
        : { href: "/choose-plan", label: "See plans" };

/**
 * How a locked screen names what unlocks it, phrased for the edition —
 * "on Teams and Enterprise" is a plan you buy, "with an Enterprise
 * license" is a key you paste.
 */
export const availabilityLine = (cloudTiers = "Teams and Enterprise") =>
    isSelfHosted
        ? "Available with an Enterprise license."
        : `Available on ${cloudTiers}.`;

/** Just the tier name, for a sentence that supplies its own verb. */
export const unlockedByLabel = (cloudTiers = "Teams and Enterprise") =>
    isSelfHosted ? "an Enterprise license" : cloudTiers;
