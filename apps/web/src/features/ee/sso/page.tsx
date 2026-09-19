import { LockedFeatureOverlay } from "@components/system/locked-feature-overlay";
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

    // SSO is enterprise-only (trials get a preview). Mirrors the sidebar
    // visibility in app/(app)/organization/_components/sidebar.tsx — the
    // menu hides the link, this guard blocks direct URL access.
    const isTrial = license?.subscriptionStatus === "trial";
    const isEnterprise = license ? isEnterprisePlan(license) : false;
    if (!isEnterprise && !isTrial) {
        // The menu shows SSO with a padlock; here the page itself explains
        // the gate instead of bouncing the user somewhere else.
        await captureGateHit({
            feature: "sso",
            plan: license?.subscriptionStatus,
            metadata: { surface: "locked_preview" },
        });
        return (
            <LockedFeatureOverlay
                title="Unlock single sign-on"
                description="SAML SSO with your identity provider, domain-based access and enforced login are available on the Enterprise plan."
                cta={{
                    label: "Upgrade plan",
                    href: "/settings/subscription",
                    feature: "sso",
                    plan: license?.subscriptionStatus,
                    metadata: { surface: "locked_preview" },
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
