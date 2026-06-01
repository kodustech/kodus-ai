import type { Scenario } from "../lib/types.js";
import codeReviewBasic from "./code-review-basic.js";
import commandReview from "./command-review.js";
import kodyRulesCreateAndApply from "./kody-rules.js";
import licenseAttribution from "./license-attribution.js";
import onboardingWebhookRegistration from "./onboarding-webhook-registration.js";
import perSeatLicenseToggle from "./per-seat-license-toggle.js";
import rbacAuthorization from "./rbac-authorization.js";
import ssoCookieDomain from "./sso-cookie-domain.js";
import ssoMultiUser from "./sso-multi-user.js";
import stripeBilling from "./stripe-billing.js";
import upgradeNMinusOneToN from "./upgrade.js";

export const allScenarios: Record<string, Scenario> = {
    [onboardingWebhookRegistration.id]: onboardingWebhookRegistration,
    [codeReviewBasic.id]: codeReviewBasic,
    [commandReview.id]: commandReview,
    [kodyRulesCreateAndApply.id]: kodyRulesCreateAndApply,
    [licenseAttribution.id]: licenseAttribution,
    [perSeatLicenseToggle.id]: perSeatLicenseToggle,
    [rbacAuthorization.id]: rbacAuthorization,
    [ssoCookieDomain.id]: ssoCookieDomain,
    [ssoMultiUser.id]: ssoMultiUser,
    [stripeBilling.id]: stripeBilling,
    [upgradeNMinusOneToN.id]: upgradeNMinusOneToN,
};

export function resolveScenarios(ids: string[]): Scenario[] {
    return ids.map((id) => {
        const s = allScenarios[id];
        if (!s) {
            throw new Error(
                `Unknown scenario: ${id}. Known: ${Object.keys(allScenarios).join(", ")}`,
            );
        }
        return s;
    });
}

export {
    codeReviewBasic,
    commandReview,
    kodyRulesCreateAndApply,
    licenseAttribution,
    onboardingWebhookRegistration,
    perSeatLicenseToggle,
    rbacAuthorization,
    ssoCookieDomain,
    ssoMultiUser,
    stripeBilling,
    upgradeNMinusOneToN,
};
