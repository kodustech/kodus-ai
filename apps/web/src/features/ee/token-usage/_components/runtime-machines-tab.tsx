"use client";

import { MachineTimeToday } from "@components/runtime/machine-time-today";
import { RuntimeSection } from "@components/runtime/section";
import { RuntimeUsageContent } from "@components/runtime/usage-report";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";

/** The "Runtime machines" tab: today's machine minutes and daily limit, then the month's Runtime usage. */
export const RuntimeMachinesTab = () => {
    // The organization's daily limit is organization-wide, like the token budget on the Runtime settings page.
    const canEditOrg = usePermission(
        Action.Update,
        ResourceType.OrganizationSettings,
    );
    return (
        <div className="flex flex-col gap-6">
            <RuntimeSection
                title="Today"
                description="Minutes of Kody's machines (setups, Runs, environment sessions) the organization used today (UTC), against its daily limit. A machine still running holds its whole ceiling until it ends.">
                <MachineTimeToday canEdit={canEditOrg} />
            </RuntimeSection>
            <RuntimeUsageContent />
        </div>
    );
};
