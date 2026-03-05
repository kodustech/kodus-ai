import { redirect } from "next/navigation";
import { getOrganizationId } from "@services/organizations/fetch";
import { getTeamParametersNoCache } from "@services/parameters/fetch";
import { ParametersConfigKey } from "@services/parameters/types";
import { Action, ResourceType } from "@services/permissions/types";
import { auth } from "src/core/config/auth";
import { NavMenu } from "src/core/layout/navbar";
import { TEAM_STATUS } from "src/core/types";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { BYOKMissingKeyTopbar } from "src/features/ee/byok/_components/missing-key-topbar";
import { isBYOKSubscriptionPlan } from "src/features/ee/byok/_utils";
import { FinishedTrialModal } from "src/features/ee/subscription/_components/finished-trial-modal";
import { SubscriptionStatusTopbar } from "src/features/ee/subscription/_components/subscription-status-topbar";
import { SubscriptionProvider } from "src/features/ee/subscription/_providers/subscription-context";

import { getLayoutData, getTeamsCached } from "./_helpers/get-layout-data";
import { Providers } from "./providers";
import { AppRightSidebar } from "./right-sidebar";

export default async function Layout({ children }: React.PropsWithChildren) {
    const session = await auth();
    if (!session) {
        redirect("/sign-out");
    }

    const userStatus = session.user?.status
        ? String(session.user.status).toLowerCase()
        : undefined;

    if (userStatus && ["pending", "pending_email"].includes(userStatus)) {
        redirect("/confirm-email");
    }

    // Fetch teams (cached, returns [] on error)
    const teams = await getTeamsCached();

    if (!teams?.some((team) => team.status === TEAM_STATUS.ACTIVE)) {
        redirect("/setup");
    }

    const teamId = await getGlobalSelectedTeamId();

    // Platform configs check - this one we keep uncached as it controls redirects
    const platformConfigs = await getTeamParametersNoCache<{
        configValue: { finishOnboard?: boolean };
    }>({
        key: ParametersConfigKey.PLATFORM_CONFIGS,
        teamId,
    }).catch((err) => {
        console.error("[Layout] Failed to fetch platform configs:", err);
        return null;
    });

    if (platformConfigs && !platformConfigs?.configValue?.finishOnboard) {
        redirect("/setup");
    }

    const organizationId = await getOrganizationId();

    // Fetch all layout data (cached for 60 seconds)
    const {
        permissions,
        organizationName,
        organizationLicense,
        usersWithAssignedLicense,
        byokConfig,
        featureFlags,
    } = await getLayoutData(teamId, organizationId);

    const isBYOK = organizationLicense
        ? isBYOKSubscriptionPlan(organizationLicense)
        : false;
    const isTrial = organizationLicense?.subscriptionStatus === "trial";

    const canManageCodeReview = !!(
        (
            permissions as Record<string, Record<string, boolean>> | undefined
        )?.[ResourceType.CodeReviewSettings]?.[Action.Manage]
    );

    return (
        <Providers
            session={session}
            teams={teams}
            organization={{
                id: organizationId,
                name: organizationName,
            }}
            permissions={permissions}
            isBYOK={isBYOK}
            isTrial={isTrial}
            featureFlags={featureFlags}>
            <SubscriptionProvider
                license={
                    organizationLicense ?? {
                        valid: false,
                        subscriptionStatus: "inactive",
                        numberOfLicenses: 0,
                    }
                }
                usersWithAssignedLicense={usersWithAssignedLicense}>
                <NavMenu />
                <FinishedTrialModal />
                <SubscriptionStatusTopbar />

                {isBYOK && !byokConfig?.main && <BYOKMissingKeyTopbar />}

                {children}

                <AppRightSidebar
                    showTestReview={
                        !!featureFlags?.codeReviewDryRun && canManageCodeReview
                    }
                />
            </SubscriptionProvider>
        </Providers>
    );
}
