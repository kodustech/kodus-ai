import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { getAutoLicenseAssignmentConfig } from "src/lib/services/organizationParameters/fetch";

import {
    getOrganizationMembers,
    getUsersWithLicense,
    MEMBERS_UNAVAILABLE,
    validateOrganizationLicense,
} from "../_services/billing/fetch";
import type { LicenseTableRow } from "./_components/columns";
import { LicensesPageClient } from "./_components/page.client";

export default async function SubscriptionTabs() {
    const teamId = await getGlobalSelectedTeamId();

    const [memberList, usersWithLicense, license, autoLicenseAssignmentConfig] =
        await Promise.all([
            getOrganizationMembers({ teamId }).catch(() => MEMBERS_UNAVAILABLE),
            getUsersWithLicense({ teamId }).catch(() => []),
            validateOrganizationLicense({ teamId }).catch(() => ({
                valid: false,
                subscriptionStatus: "inactive" as const,
            })),
            getAutoLicenseAssignmentConfig().catch(() => undefined),
        ]);

    // Without a confirmed member list we cannot tell who left the org, so no row
    // is flagged as removed and seat pruning stays unavailable.
    const membersUnavailable = memberList.status !== "ok";
    const organizationMembers = memberList.members;

    const organizationMemberIds = new Set(
        organizationMembers.map((m) => m.id.toString()),
    );

    const usersWithLicenseByGitId = new Map(
        usersWithLicense.map((u) => [u.git_id, u]),
    );

    const organizationMembersWithLicense: LicenseTableRow[] = [
        ...organizationMembers.map((member) => {
            const normalizedName =
                member.name?.trim() ||
                member.displayName?.trim() ||
                member.username?.trim() ||
                member.login?.trim() ||
                "Unknown member";

            const user = usersWithLicenseByGitId.get(member.id.toString());

            return {
                id: member.id,
                name: normalizedName,
                licenseStatus:
                    license.valid && license.subscriptionStatus === "trial"
                        ? "active"
                        : user?.git_id && (user?.status ?? "active") === "active"
                          ? "active"
                          : "inactive",
            } satisfies LicenseTableRow;
        }),
        ...usersWithLicense
            .filter(
                (userWithLicense) =>
                    !organizationMemberIds.has(userWithLicense.git_id) &&
                    userWithLicense.status !== "inactive",
            )
            .map((userWithLicense) => ({
                id: userWithLicense.git_id,
                name: membersUnavailable
                    ? userWithLicense.git_id
                    : `Deleted user (${userWithLicense.git_id})`,
                licenseStatus: userWithLicense.status ?? "active",
                removedFromGit: !membersUnavailable,
            })),
    ];

    return (
        <LicensesPageClient
            data={organizationMembersWithLicense}
            autoLicenseAssignmentConfig={autoLicenseAssignmentConfig}
            membersUnavailable={membersUnavailable}
        />
    );
}
