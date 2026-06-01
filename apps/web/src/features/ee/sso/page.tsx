import { redirect } from "next/navigation";
import { getSSOConfig } from "@services/ssoConfig/fetch";
import { auth } from "src/core/config/auth";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { isEnterprisePlan } from "src/features/ee/byok/_utils";
import { validateOrganizationLicense } from "src/features/ee/subscription/_services/billing/fetch";
import { SSOConfig, SSOProtocol } from "src/lib/auth/types";

import { ClientSsoOrganizationSettingsPage } from "./_page-component";

export default async function SsoOrganizationSettingsPage() {
    const teamId = await getGlobalSelectedTeamId();
    const license = await validateOrganizationLicense({ teamId }).catch(
        () => null,
    );

    // SSO is enterprise-only (trials get a preview). Mirrors the sidebar
    // visibility in app/(app)/organization/_components/sidebar.tsx — the
    // menu hides the link, this guard blocks direct URL access.
    const isTrial = license?.subscriptionStatus === "trial";
    const isEnterprise = license ? isEnterprisePlan(license) : false;
    if (!isEnterprise && !isTrial) {
        redirect("/organization/general");
    }

    const jwtPayload = await auth();
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
