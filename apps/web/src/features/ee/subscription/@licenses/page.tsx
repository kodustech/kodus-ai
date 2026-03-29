import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { getAutoLicenseAssignmentConfig } from "src/lib/services/organizationParameters/fetch";

import {
    getOrganizationMembers,
    getUsersWithLicense,
    validateOrganizationLicense,
} from "../_services/billing/fetch";
import type { LicenseTableRow } from "./_components/columns";
import { LicensesPageClient } from "./_components/page.client";

export default async function SubscriptionTabs() {
    const teamId = await getGlobalSelectedTeamId();

    const [
        organizationMembersRaw,
        usersWithLicense,
        license,
        autoLicenseAssignmentConfig,
    ] = await Promise.all([
        getOrganizationMembers({ teamId }).catch(() => []),
        getUsersWithLicense({ teamId }).catch(() => []),
        validateOrganizationLicense({ teamId }).catch(() => ({
            valid: false,
            subscriptionStatus: "inactive" as const,
        })),
        getAutoLicenseAssignmentConfig().catch(() => undefined),
    ]);

    const organizationMembers = Array.isArray(organizationMembersRaw)
        ? organizationMembersRaw
        : [];

    const organizationMembersWithLicense: LicenseTableRow[] =
        organizationMembers.map((member) => {
            const normalizedName =
                member.name?.trim() ||
                member.displayName?.trim() ||
                member.username?.trim() ||
                member.login?.trim() ||
                "Unknown member";

            const user = usersWithLicense.find(
                (userWithLicense) =>
                    userWithLicense.git_id === member.id.toString(),
            );

            return {
                id: member.id,
                name: normalizedName,
                licenseStatus:
                    license.valid && license.subscriptionStatus === "trial"
                        ? "active"
                        : user?.git_id
                          ? "active"
                          : "inactive",
            };
        });

    return (
        <LicensesPageClient
            data={organizationMembersWithLicense}
            autoLicenseAssignmentConfig={autoLicenseAssignmentConfig}
        />
    );
}
