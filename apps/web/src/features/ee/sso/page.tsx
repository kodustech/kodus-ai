import { LockedFeatureOverlay } from "@components/system/locked-feature-overlay";
import { planCtaTarget } from "@components/system/plan-cta-target";
import { LockedFeatureUnlocks } from "@components/system/locked-feature-unlocks";
import { LockedPagePreview } from "@components/system/locked-page-preview";
import { getSSOConfig } from "@services/ssoConfig/fetch";
import { auth } from "src/core/config/auth";
import { captureGateHit } from "src/core/utils/gate-hit";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { isEnterprisePlan } from "src/features/ee/byok/_utils";
import { validateOrganizationLicense } from "src/features/ee/subscription/_services/billing/fetch";
import { SSOConfig, SSOProtocol } from "src/lib/auth/types";

import { ClientSsoOrganizationSettingsPage } from "./_page-component";

export default async function SsoOrganizationSettingsPage() {
    // auth() is independent of the team id, so resolve both in parallel; the
    // license still depends on teamId and runs next.
    const [teamId, jwtPayload] = await Promise.all([
        getGlobalSelectedTeamId(),
        auth(),
    ]);
    const license = await validateOrganizationLicense({ teamId }).catch(
        () => null,
    );

    // SSO is enterprise-only (trials get a preview). Mirrors the padlock on
    // SSO in the sidebar's Organization group (core/layout/sidebar) — the
    // menu flags the link, this guard blocks direct URL access.
    const isTrial = license?.subscriptionStatus === "trial";
    const isEnterprise = license ? isEnterprisePlan(license) : false;
    if (!isEnterprise && !isTrial) {
        // The menu shows SSO with a padlock; here the page itself explains
        // the gate instead of bouncing the user somewhere else.
        await captureGateHit({
            feature: "sso",
            surface: "locked_preview",
            planType: license?.planType,
            subscriptionStatus: license?.subscriptionStatus,
        });
        return (
            <LockedFeatureOverlay
                title="Unlock single sign-on"
                description="Your team signs in with passwords Kodus stores. On Enterprise, they sign in with your identity provider — and stop being able to sign in the day you offboard them."
                details={
                    <LockedFeatureUnlocks
                        items={[
                            "SAML with Okta, Entra ID, Google Workspace or any SAML 2.0 IdP",
                            "Verified domains: only your people can join the org",
                            "Enforced login — password sign-in switched off",
                        ]}
                    />
                }
                cta={{
                    ...planCtaTarget(),
                    feature: "sso",
                    surface: "locked_preview",
                    planType: license?.planType,
                    subscriptionStatus: license?.subscriptionStatus,
                }}>
                <LockedPagePreview title="SSO" />
            </LockedFeatureOverlay>
        );
    }

    const email = jwtPayload?.user?.email ?? "";

    let ssoConfig: SSOConfig<SSOProtocol.SAML> = {
        protocol: SSOProtocol.SAML,
        active: false,
        providerConfig: {
            idpIssuer: "",
            issuer: "",
            entryPoint: "",
            cert: "",
        },
        domains: [],
    };

    try {
        const result = await getSSOConfig({
            protocol: SSOProtocol.SAML,
        });

        if (result) {
            ssoConfig = {
                protocol: result.protocol,
                active: result.active,
                providerConfig: result.providerConfig,
                uuid: result.uuid,
                domains: result.domains,
                connectionTest: result.connectionTest,
            };
        }
    } catch (error: unknown) {
        console.error(error);
    }

    return (
        <ClientSsoOrganizationSettingsPage
            email={email}
            ssoConfig={ssoConfig}
            uuid={ssoConfig.uuid}
        />
    );
}
