import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { getAutoLicenseAssignmentConfig } from "src/lib/services/organizationParameters/fetch";

import {
    getOrganizationMemberLabels,
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

    // Only a complete list can say who left the org. A partial one is still
    // shown, but nobody missing from it is flagged as removed.
    const membersComplete = memberList.status === "ok" && memberList.complete;
    // When the provider checks unlisted seat holders, only the ones it
    // confirmed absent are removed; a seat it never saw is not.
    const confirmedAbsent =
        memberList.status === "ok" && memberList.absentSeatHolderIds
            ? new Set(memberList.absentSeatHolderIds)
            : null;
    const isRemovedFromGit = (gitId: string) =>
        membersComplete && (!confirmedAbsent || confirmedAbsent.has(gitId));
    const organizationMembers = memberList.members;

    const organizationMemberIds = new Set(
        organizationMembers.map((m) => m.id.toString()),
    );

    const unlistedSeatHolders = usersWithLicense.filter(
        (userWithLicense) =>
            !organizationMemberIds.has(userWithLicense.git_id) &&
            userWithLicense.status !== "inactive",
    );

    const seatHolderLabels: Record<string, string> =
        unlistedSeatHolders.length > 0
            ? await getOrganizationMemberLabels({
                  teamId,
                  ids: unlistedSeatHolders.map((u) => u.git_id),
              }).catch(() => ({}))
            : {};

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
                isBot: member.type === "bot",
                licenseStatus:
                    license.valid && license.subscriptionStatus === "trial"
                        ? "active"
                        : user?.git_id &&
                            (user?.status ?? "active") === "active"
                          ? "active"
                          : "inactive",
            } satisfies LicenseTableRow;
        }),
        ...unlistedSeatHolders.map((userWithLicense) => ({
            id: userWithLicense.git_id,
            name:
                seatHolderLabels[userWithLicense.git_id] ??
                userWithLicense.git_id,
            licenseStatus: userWithLicense.status ?? "active",
            removedFromGit: isRemovedFromGit(userWithLicense.git_id),
        })),
    ];

    return (
        <LicensesPageClient
            data={organizationMembersWithLicense}
            autoLicenseAssignmentConfig={autoLicenseAssignmentConfig}
            membersUnavailable={!membersComplete}
        />
    );
}
