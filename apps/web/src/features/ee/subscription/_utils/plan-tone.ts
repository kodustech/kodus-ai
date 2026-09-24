/**
 * How a plan looks wherever it's shown — the sidebar's plan panel and the
 * subscription page — so the two read as one system: a tier chip in the
 * tier's tone, the surface's border echoing it, and meters in the same hue.
 *
 * Trial takes the brand orange, Teams lavender, Enterprise blue (the rose
 * pair read as an error beside a failed payment). Free and Community stay
 * neutral — they are the floor, not a tier to show off.
 */
export type PlanTone = "neutral" | "primary" | "secondary" | "info" | "danger";

export const PLAN_CHIP_TONE: Record<PlanTone, string> = {
    neutral: "bg-card-lv3 text-text-secondary",
    primary: "bg-primary-dark text-primary-light",
    secondary: "bg-secondary-dark text-secondary-light",
    info: "bg-info/15 text-info",
    danger: "bg-danger/15 text-danger",
};

export const PLAN_BORDER_TONE: Record<PlanTone, string> = {
    neutral: "border-card-lv3/60",
    primary: "border-primary-light/25",
    secondary: "border-secondary-light/25",
    info: "border-info/30",
    danger: "border-danger/40",
};

export const PLAN_BAR_TONE: Record<PlanTone, string> = {
    neutral: "bg-text-secondary",
    primary: "bg-primary-light",
    secondary: "bg-secondary-light",
    info: "bg-info",
    danger: "bg-danger",
};

/** Marks drawn in the tier's hue, e.g. the checks of a plan's feature list. */
export const PLAN_TEXT_TONE: Record<PlanTone, string> = {
    neutral: "text-text-tertiary",
    primary: "text-primary-light",
    secondary: "text-secondary-light",
    info: "text-info",
    danger: "text-danger",
};

/** The tier a billing plan type belongs to, as the product names it. */
export const tierOf = (planType?: string) =>
    planType?.startsWith("enterprise")
        ? "Enterprise"
        : planType?.startsWith("teams")
          ? "Teams"
          : undefined;

export const toneOfTier = (tier?: string): PlanTone =>
    tier === "Enterprise" ? "info" : tier === "Teams" ? "secondary" : "neutral";

/** Who runs the models the plan reviews with. */
export const modelsOf = (planType?: string) =>
    planType?.includes("byok") ? "BYOK" : "Managed";

export const billingIntervalOf = (planType?: string) =>
    planType?.endsWith("_annual") ? "Billed yearly" : "Billed monthly";
