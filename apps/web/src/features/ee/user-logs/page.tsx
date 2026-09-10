import { LockedFeatureOverlay } from "@components/system/locked-feature-overlay";
import { LockedPagePreview } from "@components/system/locked-page-preview";
import { captureGateHit } from "src/core/utils/gate-hit";
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
        await captureGateHit({
            feature: "activity_logs",
            plan: license?.subscriptionStatus,
            metadata: { surface: "locked_preview" },
        });
        return (
            <LockedFeatureOverlay
                title="Unlock activity logs"
                description="Who changed what, and when: a full audit trail of your organization's settings, rules and reviews is available on the Enterprise plan."
                cta={{
                    label: "Upgrade plan",
                    href: "/settings/subscription",
                    feature: "activity_logs",
                    plan: license?.subscriptionStatus,
                    metadata: { surface: "locked_preview" },
                }}>
                <LockedPagePreview title="Activity logs" rows={4} />
            </LockedFeatureOverlay>
        );
    }

    return <UserLogsPageClient />;
}
