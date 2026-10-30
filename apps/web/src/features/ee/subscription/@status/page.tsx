import { authorizedFetch } from "@services/fetch";
import { getLLMConfigStatus } from "@services/organizationParameters/fetch";
import { SETUP_PATHS } from "@services/setup";
import { hasVisibleModels } from "src/features/ee/byok/_utils";
import type { TeamMembersResponse } from "@services/setup/types";
import { auth } from "src/core/config/auth";
import { publicDomainsSet } from "src/core/utils/email";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";

import {
    getOrganizationMembers,
    MEMBERS_UNAVAILABLE,
    recalculateTrialUnlocks,
} from "../_services/billing/fetch";
import { Redirect } from "./_components";

const hasCompanyEmail = (email?: string | null) => {
    const domain = email?.split("@")[1]?.toLowerCase();

    return Boolean(domain && !publicDomainsSet.has(domain));
};

export default async function SubscriptionStatus() {
    const teamId = await getGlobalSelectedTeamId();
    const [session, { members }, organizationMembers, llmConfigStatus] =
        await Promise.all([
            auth(),
            authorizedFetch<TeamMembersResponse>(SETUP_PATHS.TEAM_MEMBERS, {
                params: { teamId },
            }),
            getOrganizationMembers({ teamId }).catch(() => MEMBERS_UNAVAILABLE),
            getLLMConfigStatus().catch(() => undefined),
        ]);

    // BYOK config lives in the API (org parameters), not in billing — so the
    // billing license never knows a key was connected. Detect it here and use
    // it both as a recalc signal and as the source of truth for `byok`. Use the
    // same credential-aware signal as the app layout (`byok.configured` requires
    // real credentials) so this page and the app chrome can never disagree.
    const hasByok = Boolean(llmConfigStatus?.byok?.configured);

    // Stays undefined when the code host could not be reached: "unknown" must
    // not be reported as a real headcount to the trial-unlock signals.
    const codeHostMembersCount =
        organizationMembers.status === "ok"
            ? organizationMembers.members.length
            : undefined;
    const recalculatedLicense = await recalculateTrialUnlocks({
        teamId,
        signals: {
            companyEmailVerified: hasCompanyEmail(session?.user?.email),
            workspaceMembersCount: members.length,
            codeHostMembersCount,
            byok: hasByok,
        },
    }).catch(() => undefined);
    const trialLicense =
        recalculatedLicense?.valid &&
            recalculatedLicense.subscriptionStatus === "trial"
            ? {
                ...recalculatedLicense,
                // Local config is the source of truth for a connected key;
                // billing's plan-derived `byok` stays true for a *_byok plan
                // even with no key, so never OR it in here.
                byok: hasByok,
            }
            : undefined;

    return (
        <Redirect
            members={members}
            codeHostMembersCount={codeHostMembersCount}
            trialLicense={trialLicense}
        />
    );
}
