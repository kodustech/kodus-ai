import type { Scenario } from '../lib/types.js';
import centralizedConfigSync from './centralized-config-sync.js';
import cockpitAnalytics from './cockpit-analytics.js';
import codeReviewBasic from './code-review-basic.js';
import codeReviewVertexByok from './code-review-vertex-byok.js';
import conversationVertexByok from './conversation-vertex-byok.js';
import commandReview from './command-review.js';
import kodyRulesCreateAndApply from './kody-rules.js';
import licenseAttribution from './license-attribution.js';
import onboardingWebhookRegistration from './onboarding-webhook-registration.js';
import perSeatLicenseToggle from './per-seat-license-toggle.js';
import publicPrDemo from './public-pr-demo.js';
import rbacAuthorization from './rbac-authorization.js';
import rbacFrontendRoutes from './rbac-frontend-routes.js';
import rbacUiRender from './rbac-ui-render.js';
import ssoCookieDomain from './sso-cookie-domain.js';
import ssoMultiUser from './sso-multi-user.js';
import stripeBilling from './stripe-billing.js';
import trialCreditsConsume from './trial-credits-consume.js';
import trialEntitlementGate from './trial-entitlement-gate.js';
import trialManagedReview from './trial-managed-review.js';
import upgradeNMinusOneToN from './upgrade.js';

export const allScenarios: Record<string, Scenario> = {
    [onboardingWebhookRegistration.id]: onboardingWebhookRegistration,
    [codeReviewBasic.id]: codeReviewBasic,
    [codeReviewVertexByok.id]: codeReviewVertexByok,
    [conversationVertexByok.id]: conversationVertexByok,
    [centralizedConfigSync.id]: centralizedConfigSync,
    [commandReview.id]: commandReview,
    [cockpitAnalytics.id]: cockpitAnalytics,
    [kodyRulesCreateAndApply.id]: kodyRulesCreateAndApply,
    [licenseAttribution.id]: licenseAttribution,
    [perSeatLicenseToggle.id]: perSeatLicenseToggle,
    [publicPrDemo.id]: publicPrDemo,
    [rbacAuthorization.id]: rbacAuthorization,
    [rbacFrontendRoutes.id]: rbacFrontendRoutes,
    [rbacUiRender.id]: rbacUiRender,
    [ssoCookieDomain.id]: ssoCookieDomain,
    [ssoMultiUser.id]: ssoMultiUser,
    [stripeBilling.id]: stripeBilling,
    [trialCreditsConsume.id]: trialCreditsConsume,
    [trialEntitlementGate.id]: trialEntitlementGate,
    [trialManagedReview.id]: trialManagedReview,
    [upgradeNMinusOneToN.id]: upgradeNMinusOneToN,
};

export function resolveScenarios(ids: string[]): Scenario[] {
    return ids.map((id) => {
        const s = allScenarios[id];
        if (!s) {
            throw new Error(
                `Unknown scenario: ${id}. Known: ${Object.keys(allScenarios).join(', ')}`,
            );
        }
        return s;
    });
}

export {
    centralizedConfigSync,
    cockpitAnalytics,
    codeReviewBasic,
    codeReviewVertexByok,
    conversationVertexByok,
    commandReview,
    kodyRulesCreateAndApply,
    licenseAttribution,
    onboardingWebhookRegistration,
    perSeatLicenseToggle,
    publicPrDemo,
    rbacAuthorization,
    rbacFrontendRoutes,
    rbacUiRender,
    ssoCookieDomain,
    ssoMultiUser,
    stripeBilling,
    trialCreditsConsume,
    trialEntitlementGate,
    trialManagedReview,
    upgradeNMinusOneToN,
};
