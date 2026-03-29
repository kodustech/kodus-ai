export type OrganizationLicenseInvalid = {
    valid: false;
    subscriptionStatus: "payment_failed" | "canceled" | "expired" | "inactive";
    numberOfLicenses: number;
    planType?: PlanType;
    stripeCustomerId?: string | null;
};

export type OrganizationLicenseTrial = {
    valid: true;
    subscriptionStatus: "trial";
    trialEnd: string;
};

export type PlanType =
    | "free_byok"
    | "teams_byok"
    | "teams_byok_annual"
    | "teams_managed"
    | "teams_managed_annual"
    | "teams_managed_legacy"
    | "enterprise_byok"
    | "enterprise_byok_annual"
    | "enterprise_managed"
    | "enterprise_managed_annual"
    | "enterprise";

export type OrganizationLicenseActive = {
    valid: true;
    subscriptionStatus: "active";
    numberOfLicenses: number;
    planType: PlanType;
};

export type OrganizationLicenseSelfHosted = {
    valid: true;
    subscriptionStatus: "self-hosted";
};

export type OrganizationLicenseLicensedSelfHosted = {
    valid: true;
    subscriptionStatus: "licensed-self-hosted";
    planType: PlanType;
    numberOfLicenses: number;
    expiresAt?: string;
};

export type OrganizationLicense =
    | OrganizationLicenseInvalid
    | OrganizationLicenseTrial
    | OrganizationLicenseActive
    | OrganizationLicenseSelfHosted
    | OrganizationLicenseLicensedSelfHosted;

type PlanOrAddonPricing = {
    amount: number;
    priceId: string;
    currency: string;
    interval: "month" | "year";
    planType: string;
    intervalCount: number;
    formattedAmount: string;
};

type PlanAddon = {
    id: string;
    label: string;
    description: string;
    aliases: Array<string>;
    features: Array<string>;
    pricing: Array<PlanOrAddonPricing>;
};

export type Plan = {
    id: string;
    label: string;
    type: "plan" | "contact";
    description: string;
    features: Array<string>;
    aliases?: Array<string>;
    addons: Array<PlanAddon>;
    pricing: Array<PlanOrAddonPricing>;
};
