import { redirect } from "next/navigation";
import { Badge } from "@components/ui/badge";
import { Page } from "@components/ui/page";
import {
    getRepositorySelection,
    type RepositorySelection,
} from "@services/codeManagement/repositorySelection";
import { getWebhookCreationFailures } from "@services/codeManagement/webhookCreationFailures";
import { getIntegrationConfig } from "@services/integrations/integrationConfig/fetch";
import { getConnections } from "@services/setup/fetch";
import { ErrorCard } from "src/core/components/ui/error-card";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "src/core/components/ui/tabs";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { getCurrentPathnameOnServerComponents } from "src/core/utils/headers";
import { safeArray } from "src/core/utils/safe-array";
import {
    getOrganizationMembers,
    MEMBERS_UNAVAILABLE,
} from "src/features/ee/subscription/_services/billing/fetch";
import { getAutoLicenseAssignmentConfig } from "src/lib/services/organizationParameters/fetch";

import { GitProviders } from "./_components/_providers";
import { GitConnectedProvider } from "./_components/connected-provider";
import { IgnoredUsersCard } from "./_components/ignored-users-card";
import { ReviewAllRepositoriesCard } from "./_components/review-all-repositories-card";
import { GitRepositoriesTable } from "./_components/table";

const MANUAL_SELECTION: RepositorySelection = {
    mode: "manual",
    includeForksAndMirrors: false,
    sync: null,
};

export default async function GitSettings() {
    const teamId = await getGlobalSelectedTeamId();

    let connectionsResult: Awaited<ReturnType<typeof getConnections>> = [];
    let connectedRepositories: Awaited<
        ReturnType<typeof getIntegrationConfig>
    > = [];
    let autoLicenseAssignmentConfig: Awaited<
        ReturnType<typeof getAutoLicenseAssignmentConfig>
    > = undefined;
    let organizationMembersRaw: Awaited<
        ReturnType<typeof getOrganizationMembers>
    > = MEMBERS_UNAVAILABLE;
    let webhookFailures: Awaited<
        ReturnType<typeof getWebhookCreationFailures>
    > = {};
    let webhookFailuresUnavailable = false;
    let repositorySelection: RepositorySelection = MANUAL_SELECTION;
    let connectionsError = false;

    try {
        [
            connectionsResult,
            connectedRepositories,
            autoLicenseAssignmentConfig,
            organizationMembersRaw,
            webhookFailures,
            repositorySelection,
        ] = await Promise.all([
            getConnections(teamId),
            getIntegrationConfig({ teamId }),
            getAutoLicenseAssignmentConfig().catch(() => undefined),
            getOrganizationMembers({ teamId }).catch(() => MEMBERS_UNAVAILABLE),
            // Ancillary read: left unguarded it would reject the whole batch
            // and blank the connections and repositories that loaded fine,
            // because those are only assigned by the destructuring. So it is
            // guarded -- but NOT with an empty payload, which reads as the
            // healthy "this team has no webhook failures": the table is told
            // the status could not be loaded instead (#2003 review).
            getWebhookCreationFailures(teamId).catch(() => {
                webhookFailuresUnavailable = true;
                return {};
            }),
            getRepositorySelection(teamId).catch(() => MANUAL_SELECTION),
        ]);
    } catch (err) {
        console.error("[GitSettings] error fetching data:", err);
        connectionsError = true;
    }

    const connections = safeArray(connectionsResult);

    const organizationMembers =
        organizationMembersRaw.status === "ok"
            ? organizationMembersRaw.members.map((member) => {
                  const normalizedName =
                      member.name?.trim() ||
                      member.displayName?.trim() ||
                      member.username?.trim() ||
                      member.login?.trim() ||
                      "Unknown member";

                  return { id: member.id.toString(), name: normalizedName };
              })
            : [];

    const gitConnection = connections.find(
        (c) => c.category === "CODE_MANAGEMENT",
    );

    const hasFilters =
        (autoLicenseAssignmentConfig?.ignoredUsers?.length ?? 0) > 0 ||
        (autoLicenseAssignmentConfig?.allowedUsers?.length ?? 0) > 0;

    const pathname = await getCurrentPathnameOnServerComponents();

    // 1. condition: team has a git provider connected, but no repositories were selected;
    // 2. pathname checking to avoid infinite redirect loop with Parallel Route `/settings/git/repositories`;
    // 3. a team reviewing every repository may have none yet while the first sync runs;
    if (
        gitConnection &&
        connectedRepositories.length === 0 &&
        repositorySelection.mode !== "all" &&
        pathname === "/settings/git"
    ) {
        redirect("/settings/git/repositories");
    }

    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title>Repositories</Page.Title>
                    <Page.Description>
                        Which repositories Kody reviews, and which pull request
                        authors it includes or skips.
                    </Page.Description>
                </Page.TitleContainer>

                {gitConnection && (
                    <Page.HeaderActions>
                        <GitConnectedProvider connection={gitConnection} />
                    </Page.HeaderActions>
                )}
            </Page.Header>

            <Page.Content>
                <Tabs defaultValue="repositories" className="flex flex-col">
                    <TabsList className="mt-5">
                        <TabsTrigger value="repositories">
                            Repositories
                        </TabsTrigger>
                        <TabsTrigger
                            value="filters"
                            className="flex items-center gap-2">
                            PR author filters
                            {hasFilters && (
                                <Badge className="ml-2 h-2 w-2 min-w-2 rounded-full">
                                    <b>!</b>
                                </Badge>
                            )}
                        </TabsTrigger>
                        <div className="flex-1" />
                    </TabsList>

                    <TabsContent value="repositories">
                        {connectionsError ? (
                            <ErrorCard
                                variant="card"
                                message="Failed to load connections. Please try again."
                            />
                        ) : gitConnection ? (
                            <>
                                <ReviewAllRepositoriesCard
                                    platformName={gitConnection.platformName}
                                    initialSelection={repositorySelection}
                                />
                                <GitRepositoriesTable
                                    platformName={gitConnection.platformName}
                                    repositories={connectedRepositories}
                                    webhookFailures={webhookFailures}
                                    webhookFailuresUnavailable={
                                        webhookFailuresUnavailable
                                    }
                                    reviewsAllRepositories={
                                        repositorySelection.mode === "all"
                                    }
                                />
                            </>
                        ) : (
                            <GitProviders />
                        )}
                    </TabsContent>

                    <TabsContent value="filters" className="max-w-3xl">
                        <IgnoredUsersCard
                            organizationMembers={organizationMembers}
                            autoLicenseAssignmentConfig={
                                autoLicenseAssignmentConfig
                            }
                        />
                    </TabsContent>
                </Tabs>
            </Page.Content>
        </Page.Root>
    );
}
