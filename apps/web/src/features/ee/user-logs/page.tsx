import { LockedFeatureOverlay } from "@components/system/locked-feature-overlay";
import { LockedFeatureUnlocks } from "@components/system/locked-feature-unlocks";
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
                description="Kody Rules, review settings and integrations change as your team works. Right now, nothing records who changed what."
                details={
                    <LockedFeatureUnlocks
                        items={[
                            "Every settings, rule and integration change, with who made it",
                            "Filter by person, action and date",
                            "The trail an audit or a bad review run asks for",
                        ]}
                    />
                }
                cta={{
                    label: "See plans",
                    href: "/choose-plan",
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
