// eslint-disable-next-line camelcase -- Next.js's own export name
import { redirect, unstable_rethrow } from "next/navigation";
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
import { AddConnectionButton } from "./_components/add-connection";
import { GitConnectedProvider } from "./_components/connected-provider";
import { IgnoredUsersCard } from "./_components/ignored-users-card";
import { ReviewAllRepositoriesCard } from "./_components/review-all-repositories-card";
import { GitRepositoriesTable } from "./_components/table";
import { connectionLabel } from "./_constants";

// Ancillary reads fall back, but a session redirect still has to happen.
const orFallback =
    <T,>(fallback: T) =>
    (error: unknown): T => {
        unstable_rethrow(error);
        return fallback;
    };

// A few connections at a time, each reading its members and hooks.
const CONNECTIONS_READ_AT_ONCE = 3;
const inBatches = async <T, R>(
    items: T[],
    read: (item: T) => Promise<R>,
): Promise<R[]> => {
    const results: R[] = [];
    for (let i = 0; i < items.length; i += CONNECTIONS_READ_AT_ONCE) {
        results.push(
            ...(await Promise.all(
                items.slice(i, i + CONNECTIONS_READ_AT_ONCE).map(read),
            )),
        );
    }
    return results;
};

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
    let connectionsError = false;

    try {
        [
            connectionsResult,
            connectedRepositories,
            autoLicenseAssignmentConfig,
        ] = await Promise.all([
            getConnections(teamId),
            getIntegrationConfig({ teamId }),
            getAutoLicenseAssignmentConfig().catch(orFallback(undefined)),
        ]);
    } catch (err) {
        unstable_rethrow(err);
        console.error("[GitSettings] error fetching data:", err);
        connectionsError = true;
    }

    const connections = safeArray(connectionsResult);

    const toMemberOptions = (
        raw: Awaited<ReturnType<typeof getOrganizationMembers>>,
    ) =>
        raw.status === "ok"
            ? raw.members.map((member) => {
                  const normalizedName =
                      member.name?.trim() ||
                      member.displayName?.trim() ||
                      member.username?.trim() ||
                      member.login?.trim() ||
                      "Unknown member";

                  return { id: member.id.toString(), name: normalizedName };
              })
            : [];

    // An ancillary read: when it fails, the table says the status could not
    // be loaded rather than showing the healthy "no failures" (#2003 review).
    const readWebhookFailures = (connectionId?: string) =>
        getWebhookCreationFailures(teamId, connectionId)
            .then((failures) => ({ failures, unavailable: false }))
            .catch(
                orFallback({
                    failures: {} as Awaited<
                        ReturnType<typeof getWebhookCreationFailures>
                    >,
                    unavailable: true,
                }),
            );

    const gitConnections = connections.filter(
        (c) => c.category === "CODE_MANAGEMENT",
    );
    const gitConnection = gitConnections[0];
    // Laid out by the workspace's connections, which a member granted only
    // some of them does not all see.
    const severalConnections =
        gitConnections.length > 1 ||
        (gitConnection?.workspaceConnectionCount ?? 0) > 1;

    // Git ids differ per provider and host, so with several connections
    // each one reads its own members and its own webhook failures.
    const byConnection = severalConnections
        ? await inBatches(gitConnections, async (connection) => {
              const [members, webhooks] = await Promise.all([
                  getOrganizationMembers({
                      teamId,
                      connectionId: connection.connectionId,
                  })
                      .catch(orFallback(MEMBERS_UNAVAILABLE))
                      .then(toMemberOptions),
                  readWebhookFailures(connection.connectionId),
              ]);
              return { members, webhooks };
          })
        : [];

    const [organizationMembersRaw, singleWebhooks, repositorySelection] =
        !severalConnections && gitConnection
            ? await Promise.all([
                  getOrganizationMembers({ teamId }).catch(
                      orFallback(MEMBERS_UNAVAILABLE),
                  ),
                  readWebhookFailures(),
                  getRepositorySelection(teamId).catch(
                      orFallback(MANUAL_SELECTION),
                  ),
              ])
            : [
                  MEMBERS_UNAVAILABLE,
                  { failures: {}, unavailable: false },
                  MANUAL_SELECTION,
              ];

    const organizationMembers = toMemberOptions(organizationMembersRaw);
    const membersByConnection = byConnection.map((entry) => entry.members);

    const hasFilters = [
        autoLicenseAssignmentConfig,
        ...Object.values(autoLicenseAssignmentConfig?.connections ?? {}),
    ].some(
        (lists) =>
            (lists?.ignoredUsers?.length ?? 0) > 0 ||
            (lists?.allowedUsers?.length ?? 0) > 0,
    );

    const pathname = await getCurrentPathnameOnServerComponents();

    // 1. condition: team has a git provider connected, but no repositories were selected;
    // 2. pathname checking to avoid infinite redirect loop with Parallel Route `/settings/git/repositories`;
    // 3. a team reviewing every repository may have none yet while the first sync runs;
    if (
        gitConnection &&
        !severalConnections &&
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
                        {!severalConnections && (
                            <GitConnectedProvider connection={gitConnection} />
                        )}
                        <AddConnectionButton />
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
                        ) : severalConnections ? (
                            <div className="flex flex-col gap-8">
                                {gitConnections.map((connection) => (
                                    <section
                                        key={connection.connectionId}
                                        className="flex flex-col gap-4">
                                        <GitConnectedProvider
                                            connection={connection}
                                            connections={gitConnections}
                                            showConnectionActions
                                        />
                                        <GitRepositoriesTable
                                            platformName={
                                                connection.platformName
                                            }
                                            repositories={connectedRepositories.filter(
                                                (repository) =>
                                                    (
                                                        repository as {
                                                            connectionId?: string;
                                                        }
                                                    ).connectionId ===
                                                    connection.connectionId,
                                            )}
                                            connectionId={
                                                connection.connectionId
                                            }
                                            webhookFailures={
                                                byConnection[
                                                    gitConnections.indexOf(
                                                        connection,
                                                    )
                                                ]?.webhooks.failures
                                            }
                                            webhookFailuresUnavailable={
                                                byConnection[
                                                    gitConnections.indexOf(
                                                        connection,
                                                    )
                                                ]?.webhooks.unavailable
                                            }
                                            reviewsAllRepositories={false}
                                        />
                                    </section>
                                ))}
                            </div>
                        ) : gitConnection ? (
                            <>
                                <ReviewAllRepositoriesCard
                                    platformName={gitConnection.platformName}
                                    initialSelection={repositorySelection}
                                />
                                <GitRepositoriesTable
                                    platformName={gitConnection.platformName}
                                    repositories={connectedRepositories}
                                    connectionId={gitConnection.connectionId}
                                    webhookFailures={singleWebhooks.failures}
                                    webhookFailuresUnavailable={
                                        singleWebhooks.unavailable
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
                        {severalConnections ? (
                            gitConnections.map((connection, index) => (
                                <IgnoredUsersCard
                                    key={connection.connectionId}
                                    connectionId={connection.connectionId}
                                    connectionName={connectionLabel(
                                        connection,
                                        gitConnections,
                                    )}
                                    organizationMembers={
                                        membersByConnection[index] ?? []
                                    }
                                    autoLicenseAssignmentConfig={
                                        autoLicenseAssignmentConfig
                                    }
                                />
                            ))
                        ) : (
                            <IgnoredUsersCard
                                organizationMembers={organizationMembers}
                                autoLicenseAssignmentConfig={
                                    autoLicenseAssignmentConfig
                                }
                            />
                        )}
                    </TabsContent>
                </Tabs>
            </Page.Content>
        </Page.Root>
    );
}
