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
    byok?: boolean;
    trialReviewCreditsTotal?: number;
    trialReviewCreditsUsed?: number;
    trialReviewCreditsRemaining?: number;
    trialCreditTier?: TrialCreditTier;
    trialUnlocks?: Array<TrialUnlock>;
};

export type TrialCreditTier =
    | "base"
    | "team_signal"
    | "qualified"
    | "manual"
    | (string & {});

export type TrialUnlockKey =
    | "company_email"
    | "team_setup"
    | "code_org_10_plus"
    | "byok"
    | "manual_extension"
    | (string & {});

export type TrialUnlockStatus =
    | "locked"
    | "available"
    | "completed"
    | "claimed";

export type TrialUnlock = {
    key: TrialUnlockKey;
    status: TrialUnlockStatus;
    rewardCredits?: number;
    title?: string;
    description?: string;
    completedAt?: string;
};

export type TrialReviewCredits = {
    total?: number;
    used?: number;
    remaining?: number;
    tier?: TrialCreditTier;
};

export type TrialExtensionRequest = {
    teamSize?: number;
    message?: string;
    contactEmail?: string;
};

export type TrialExtensionRequestResult = {
    success: boolean;
    message?: string;
};

export type TrialUnlockSignals = {
    companyEmailVerified?: boolean;
    workspaceMembersCount?: number;
    codeHostMembersCount?: number;
    byok?: boolean;
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
