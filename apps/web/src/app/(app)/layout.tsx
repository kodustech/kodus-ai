import { redirect } from "next/navigation";
import { getTeamParametersNoCache } from "@services/parameters/fetch";
import { ParametersConfigKey } from "@services/parameters/types";
import { Action, ResourceType } from "@services/permissions/types";
import { auth } from "src/core/config/auth";
import { NavMenu } from "src/core/layout/navbar";
import { TEAM_STATUS } from "src/core/types";
import { BYOKMissingKeyTopbar } from "src/features/ee/byok/_components/missing-key-topbar";
import {
    isBYOKSubscriptionPlan,
    shouldShowBYOKMissingKeyTopbar,
} from "src/features/ee/byok/_utils";
import { FinishedTrialModal } from "src/features/ee/subscription/_components/finished-trial-modal";
import { SubscriptionStatusTopbar } from "src/features/ee/subscription/_components/subscription-status-topbar";
import { SubscriptionProvider } from "src/features/ee/subscription/_providers/subscription-context";

import { getLayoutData, getTeamsCached } from "./_helpers/get-layout-data";
import { Providers } from "./providers";
import { AppRightSidebar } from "./right-sidebar";

export default async function Layout({ children }: React.PropsWithChildren) {
    // Phase 1: auth + teams in parallel (both needed for redirect checks)
    const [session, teams] = await Promise.all([auth(), getTeamsCached()]);

    if (!session) {
        redirect("/sign-out");
    }

    const userStatus = session.user?.status
        ? String(session.user.status).toLowerCase()
        : undefined;

    if (userStatus && ["pending", "pending_email"].includes(userStatus)) {
        redirect("/confirm-email");
    }

    if (!teams?.some((team) => team.status === TEAM_STATUS.ACTIVE)) {
        redirect("/setup");
    }

    // Derive teamId from already-fetched teams (avoid refetching)
    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    const selectedTeamIdFromCookie = cookieStore.get(
        "global-selected-team-id",
    )?.value;
    const teamId =
        teams?.find((t) => t.uuid === selectedTeamIdFromCookie)?.uuid ??
        teams?.find((t) => t.status === TEAM_STATUS.ACTIVE)?.uuid!;

    // Derive organizationId from session (avoid extra auth() call)
    const organizationId = session.user?.organizationId;
    if (!organizationId) {
        redirect("/sign-out");
    }

    // Phase 2: platform config + layout data in parallel
    const [platformConfigs, layoutData] = await Promise.all([
        getTeamParametersNoCache<{
            configValue: { finishOnboard?: boolean };
        }>({
            key: ParametersConfigKey.PLATFORM_CONFIGS,
            teamId,
        }).catch((err) => {
            console.error("[Layout] Failed to fetch platform configs:", err);
            return null;
        }),
        getLayoutData(teamId, organizationId),
    ]);

    if (platformConfigs && !platformConfigs?.configValue?.finishOnboard) {
        redirect("/setup");
    }

    const {
        permissions,
        organizationName,
        organizationLicense,
        usersWithAssignedLicense,
        byokConfig,
        featureFlags,
    } = layoutData;

    const isBYOK = organizationLicense
        ? isBYOKSubscriptionPlan(organizationLicense)
        : false;
    const isTrial = organizationLicense?.subscriptionStatus === "trial";
    const showBYOKMissingKeyTopbar = shouldShowBYOKMissingKeyTopbar({
        license: organizationLicense,
        byokConfig,
        permissions,
        organizationId,
        role: session.user.role,
    });

    const canManageCodeReview = !!(
        permissions as Record<string, Record<string, boolean>> | undefined
    )?.[ResourceType.CodeReviewSettings]?.[Action.Manage];

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

                {showBYOKMissingKeyTopbar && <BYOKMissingKeyTopbar />}

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
