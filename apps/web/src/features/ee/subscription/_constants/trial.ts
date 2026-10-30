export const TRIAL_DAYS = 14;
export const TRIAL_MANAGED_REVIEW_CREDITS_INCLUDED = 5;
export const TRIAL_UNLOCK_COMPANY_EMAIL_REWARD = 5;
export const TRIAL_UNLOCK_TEAM_REWARD = 5;
export const TRIAL_UNLOCK_CODE_ORG_REWARD = 20;
export const TRIAL_UNLOCK_BYOK_REWARD_LABEL = "Unlimited with your key";

/**
 * Where the self-hosted "Request a trial" CTA points.
 *
 * Deliberately a URL on our own domain that redirects to the form, rather
 * than the form provider's URL: a self-hosted instance runs a pinned
 * version for months, so whatever we ship here is frozen in that build.
 * Redirecting lets us change the form's questions — or replace the
 * provider entirely — without stranding instances deployed before then.
 */
export const SELF_HOSTED_TRIAL_REQUEST_URL =
    "https://kodus.io/self-hosted-trial";
