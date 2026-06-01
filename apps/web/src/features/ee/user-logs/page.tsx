import { redirect } from "next/navigation";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { isEnterprisePlan } from "src/features/ee/byok/_utils";
import { validateOrganizationLicense } from "src/features/ee/subscription/_services/billing/fetch";

import { UserLogsPageClient } from "./_components/page.client";

export default async function UserLogsPage() {
    const teamId = await getGlobalSelectedTeamId();
    const license = await validateOrganizationLicense({ teamId }).catch(
        () => null,
    );

    // Activity logs is enterprise-only (trials get a preview). Mirrors the
    // dropdown visibility in core/layout/navbar/_components/user-nav.tsx —
    // the menu hides the link, this guard blocks direct URL access.
    const isTrial = license?.subscriptionStatus === "trial";
    const isEnterprise = license ? isEnterprisePlan(license) : false;
    if (!isEnterprise && !isTrial) {
        redirect("/");
    }

    return <UserLogsPageClient />;
}
