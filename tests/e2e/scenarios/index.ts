import type { Scenario } from '../lib/types.js';
import centralizedConfigSync from './centralized-config-sync.js';
import cockpitAnalytics from './cockpit-analytics.js';
import codeReviewBasic from './code-review-basic.js';
import codeReviewVertexByok from './code-review-vertex-byok.js';
import conversationVertexByok from './conversation-vertex-byok.js';
import conversationAnthropicByok from './conversation-anthropic-byok.js';
import commandReview from './command-review.js';
import commandReviewFocus from './command-review-focus.js';
import kodyRulesCreateAndApply from './kody-rules.js';
import kodyRulesFileSync from './kody-rules-file-sync.js';
import kodyRulesLifecycle from './kody-rules-lifecycle.js';
import ruleFileDetection from './rule-file-detection.js';
import kodyRulesCoverage from './kody-rules-coverage.js';
import licenseAttribution from './license-attribution.js';
import onboardingWebhookRegistration from './onboarding-webhook-registration.js';
import finishOnboardingSlo from './finish-onboarding-slo.js';
import perSeatLicenseToggle from './per-seat-license-toggle.js';
import prExecutionSse from './pr-execution-sse.js';
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
    [finishOnboardingSlo.id]: finishOnboardingSlo,
    [codeReviewBasic.id]: codeReviewBasic,
    [codeReviewVertexByok.id]: codeReviewVertexByok,
    [conversationVertexByok.id]: conversationVertexByok,
    [conversationAnthropicByok.id]: conversationAnthropicByok,
    [centralizedConfigSync.id]: centralizedConfigSync,
    [commandReview.id]: commandReview,
    [commandReviewFocus.id]: commandReviewFocus,
    [cockpitAnalytics.id]: cockpitAnalytics,
    [kodyRulesCreateAndApply.id]: kodyRulesCreateAndApply,
    [kodyRulesFileSync.id]: kodyRulesFileSync,
    [kodyRulesLifecycle.id]: kodyRulesLifecycle,
    [ruleFileDetection.id]: ruleFileDetection,
    [kodyRulesCoverage.id]: kodyRulesCoverage,
    [licenseAttribution.id]: licenseAttribution,
    [perSeatLicenseToggle.id]: perSeatLicenseToggle,
    [prExecutionSse.id]: prExecutionSse,
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
    commandReviewFocus,
    kodyRulesCreateAndApply,
    kodyRulesFileSync,
    kodyRulesLifecycle,
    ruleFileDetection,
    kodyRulesCoverage,
    licenseAttribution,
    onboardingWebhookRegistration,
    finishOnboardingSlo,
    perSeatLicenseToggle,
    prExecutionSse,
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
