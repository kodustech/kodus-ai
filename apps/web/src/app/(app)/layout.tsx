import { redirect } from "next/navigation";
import { getTeamParametersNoCache } from "@services/parameters/fetch";
import { ParametersConfigKey } from "@services/parameters/types";
import { auth } from "src/core/config/auth";
import { UserRole } from "src/core/enums";
import { NavMenu } from "src/core/layout/navbar";
import { CriticalNotificationBanner } from "src/core/layout/navbar/_components/critical-notification-banner";
import { UpdateAvailableTopbar } from "src/core/layout/update-available-topbar";
import { TEAM_STATUS } from "src/core/types";
import { BYOKMissingKeyTopbar } from "src/features/ee/byok/_components/missing-key-topbar";
import {
    isBYOKSubscriptionPlan,
    isEnterprisePlan,
    shouldShowBYOKMissingKeyTopbar,
} from "src/features/ee/byok/_utils";
import { FinishedTrialModal } from "src/features/ee/subscription/_components/finished-trial-modal";
import { SubscriptionStatusTopbar } from "src/features/ee/subscription/_components/subscription-status-topbar";
import { SubscriptionProvider } from "src/features/ee/subscription/_providers/subscription-context";

import { getLayoutData, getTeamsCached } from "./_helpers/get-layout-data";
import { Providers } from "./providers";
import { AppRightSidebar } from "./right-sidebar";

// Team-scoped layout fetches (platform config + layout data), run in parallel.
// getLayoutData is React-cache()'d on teamId, so calling this twice with the
// same teamId within a request costs a single upstream fetch.
const fetchTeamScoped = (teamId: string) =>
    Promise.all([
        getTeamParametersNoCache<{
            configValue: { finishOnboard?: boolean };
        }>({
            key: ParametersConfigKey.PLATFORM_CONFIGS,
            teamId,
        }).catch((err) => {
            console.error("[Layout] Failed to fetch platform configs:", err);
            return null;
        }),
        getLayoutData(teamId),
    ]);

export default async function Layout({ children }: React.PropsWithChildren) {
    // The selected teamId lives in a cookie (no fetch), so we can kick off the
    // team-scoped fetches up-front — in parallel with auth+teams — instead of
    // waiting for the auth→teams→teamId→layout server waterfall. If the cookie
    // team turns out to be stale/missing we refetch for the real team below
    // (rare slow path).
    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    const selectedTeamIdFromCookie = cookieStore.get(
        "global-selected-team-id",
    )?.value;

    const [session, teams, speculative] = await Promise.all([
        auth(),
        getTeamsCached(),
        selectedTeamIdFromCookie
            ? fetchTeamScoped(selectedTeamIdFromCookie)
            : Promise.resolve(null),
    ]);

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
    const teamId =
        teams?.find((t) => t.uuid === selectedTeamIdFromCookie)?.uuid ??
        teams?.find((t) => t.status === TEAM_STATUS.ACTIVE)?.uuid!;

    // Derive organizationId from session (avoid extra auth() call)
    const organizationId = session.user?.organizationId;
    if (!organizationId) {
        redirect("/sign-out");
    }

    // Reuse the speculative fetch when the cookie team matches the resolved
    // team (common case → single round-trip); otherwise fetch for the real
    // team (rare: stale or missing cookie).
    const [platformConfigs, layoutData] =
        speculative && teamId === selectedTeamIdFromCookie
            ? speculative
            : await fetchTeamScoped(teamId);

    if (platformConfigs && !platformConfigs?.configValue?.finishOnboard) {
        redirect("/setup");
    }

    const {
        permissions,
        organizationName,
        organizationLicense,
        usersWithAssignedLicense,
        llmConfigStatus,
        featureFlags,
    } = layoutData;

    const isBYOK = organizationLicense
        ? isBYOKSubscriptionPlan(organizationLicense)
        : false;
    // A configured BYOK key lives in the API, not in billing — so the trial
    // license's `byok` flag stays false even after the user connects a key.
    // Surface it from the LLM config so the trial UI (badge/banner/card)
    // reflects "unlimited with your key".
    const hasByokKey = Boolean(llmConfigStatus?.byok?.configured);
    const isTrial = organizationLicense?.subscriptionStatus === "trial";
    const isEnterprise = organizationLicense
        ? isEnterprisePlan(organizationLicense)
        : false;
    const showBYOKMissingKeyTopbar = shouldShowBYOKMissingKeyTopbar({
        license: organizationLicense,
        llmConfigStatus,
        permissions,
        organizationId,
        role: session.user.role,
    });

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
            isEnterprise={isEnterprise}
            featureFlags={featureFlags}
            initialSelectedTeamId={selectedTeamIdFromCookie}>
            <SubscriptionProvider
                license={
                    organizationLicense
                        ? ({
                              ...organizationLicense,
                              byok:
                                  hasByokKey ||
                                  (organizationLicense as { byok?: boolean })
                                      .byok,
                          } as typeof organizationLicense)
                        : {
                              valid: false,
                              subscriptionStatus: "inactive",
                              numberOfLicenses: 0,
                          }
                }
                usersWithAssignedLicense={usersWithAssignedLicense}>
                <NavMenu />
                <FinishedTrialModal />
                <CriticalNotificationBanner />
                <SubscriptionStatusTopbar />

                <UpdateAvailableTopbar
                    isOwner={session.user.role === UserRole.OWNER}
                />

                {showBYOKMissingKeyTopbar && <BYOKMissingKeyTopbar />}

                {children}

                <AppRightSidebar />
            </SubscriptionProvider>
        </Providers>
    );
}
