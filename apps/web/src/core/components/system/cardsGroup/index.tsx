"use client";

import React, { useCallback, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { SvgAzureRepos } from "@components/ui/icons/SvgAzureRepos";
import { SvgBitbucket } from "@components/ui/icons/SvgBitbucket";
import { SvgForgejo } from "@components/ui/icons/SvgForgejo";
import { SvgGithub } from "@components/ui/icons/SvgGithub";
import { SvgGitlab } from "@components/ui/icons/SvgGitlab";
import { magicModal } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import { INTEGRATIONS_KEY, type INTEGRATIONS_TYPES } from "@enums";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { useConfig } from "@providers/ConfigProvider";
import {
    createCodeManagementIntegration,
    deleteIntegration,
} from "@services/codeManagement/fetch";
import {
    checkHasConnectionByPlatform,
    cloneIntegration,
} from "@services/integrations/fetch";
import { INTEGRATION_CONFIG } from "@services/integrations/integrationConfig";
import { getTeamsWithIntegrations } from "@services/teams/fetch";
import { deleteCookie, setCookie } from "cookies-next";
import integrationFactory from "src/core/integrations/integrationFactory";
import { useAllTeams } from "src/core/providers/all-teams-context";
import { AuthMode, IntegrationCategory, PlatformType } from "src/core/types";
import { useOrganizationContext } from "src/features/organization/_providers/organization-context";

import CardConnection from "./cardConnection";
import { AzureReposModal } from "./modals/azure-repos-token";
import { BitbucketModal } from "./modals/bitbucket-token";
import { CloneOfferingModal } from "./modals/clone-offering";
import { CloneSelectTeamModal } from "./modals/clone-select-team";
import { DeleteIntegrationModal } from "./modals/delete-integration";
import { OauthOrTokenModal } from "./modals/oauth-or-token";
import TextTopIntegrations from "./textTopIntegrations";

const codeManagementPlatforms = {
    [INTEGRATIONS_KEY.GITHUB]: {
        svg: <SvgGithub />,
        platformName: "GitHub",
    },
    [INTEGRATIONS_KEY.GITLAB]: {
        svg: <SvgGitlab />,
        platformName: "Gitlab",
    },
    [INTEGRATIONS_KEY.BITBUCKET]: {
        svg: <SvgBitbucket />,
        platformName: "Bitbucket",
    },
    [INTEGRATIONS_KEY.AZURE_REPOS]: {
        svg: <SvgAzureRepos />,
        platformName: "Azure Repos",
    },
    [INTEGRATIONS_KEY.FORGEJO]: {
        svg: <SvgForgejo />,
        platformName: "Forgejo",
    },
} satisfies Partial<
    Record<
        INTEGRATIONS_KEY,
        {
            svg: React.ReactNode;
            platformName: string;
        }
    >
>;

export default function CardsGroup({
    team,
    connections: connectionsBack,
    githubEnterpriseServerPatEnabled,
}: {
    team: ReturnType<typeof useAllTeams>["teams"][number];
    githubEnterpriseServerPatEnabled: boolean;
    connections: {
        platformName: string;
        isSetupComplete: boolean;
        hasConnection: boolean;
        config?: {
            [key: string]: string;
        };
    }[];
}) {
    const router = useRouter();
    const pathname = usePathname();
    const cfg = useConfig();
    const { teams } = useAllTeams();
    const { organizationId } = useOrganizationContext();
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [integrationToDelete, setIntegrationToDelete] = useState<string>("");
    const { invalidateQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();

    const [connections] = useState<
        Array<{
            key: string;
            isSetupComplete: boolean;
            hasConnection: boolean;
            serviceType: INTEGRATIONS_TYPES;
            config?: Record<string, string>;
        }>
    >(() => {
        const _connections = [
            {
                key: INTEGRATIONS_KEY.GITHUB,
                isSetupComplete: false,
                hasConnection: false,
                serviceType: "codeManagement",
            },
            {
                key: INTEGRATIONS_KEY.GITLAB,
                isSetupComplete: false,
                hasConnection: false,
                serviceType: "codeManagement",
            },
            {
                key: INTEGRATIONS_KEY.AZURE_REPOS,
                isSetupComplete: false,
                hasConnection: false,
                serviceType: "codeManagement",
            },
            {
                key: INTEGRATIONS_KEY.BITBUCKET,
                isSetupComplete: false,
                hasConnection: false,
                serviceType: "codeManagement",
            },
            {
                key: INTEGRATIONS_KEY.FORGEJO,
                isSetupComplete: false,
                hasConnection: false,
                serviceType: "codeManagement",
            },
        ] satisfies Array<{
            key: string;
            isSetupComplete: boolean;
            hasConnection: boolean;
            serviceType: INTEGRATIONS_TYPES;
            config?: Record<string, string>;
        }>;

        const updatedConnections = _connections.map((connection) => {
            const backendInfo = connectionsBack.find(
                (backendItem) =>
                    backendItem.platformName.toUpperCase() ===
                    connection.key.toUpperCase(),
            );

            if (backendInfo) {
                return {
                    ...connection,
                    config: backendInfo.config,
                    isSetupComplete: backendInfo.isSetupComplete,
                    hasConnection: backendInfo.hasConnection,
                };
            }

            return connection;
        });

        return updatedConnections;
    });

    const editIntegration = useCallback((title: string) => {
        const formattedTitle = encodeURIComponent(
            title
                .toLowerCase()
                .replace(/[\s-]+/g, "-")
                .replace("_", "-"),
        );

        router.push(`integrations/${formattedTitle}/configuration`);
    }, []);

    // Função para verificar se há conexões desabilitadas por tipo
    const hasDisabledConnectionsByType = useCallback(
        (key: string, serviceType?: string) => {
            if (!serviceType) {
                return false;
            }

            const findConnection = connections.find(
                (connection) =>
                    connection.key.toLowerCase() !== key.toLowerCase() &&
                    connection.serviceType === serviceType &&
                    connection.hasConnection &&
                    !connection.isSetupComplete,
            );

            return !!findConnection || false;
        },
        [connections],
    );

    const connectIntegration = useCallback(
        async (key: string, serviceType?: string) => {
            if (hasDisabledConnectionsByType(key, serviceType)) return;

            const integrationConnector = integrationFactory.getConnector(
                key.toLowerCase(),
                cfg,
            );

            if (!integrationConnector) return;

            const findConnection = connections.find(
                (connection) =>
                    connection.key.toLowerCase() === key.toLowerCase(),
            );

            if (findConnection) {
                await integrationConnector.connect(
                    findConnection.hasConnection,
                    {
                        push: router.push,
                        pathname: pathname,
                    },
                    "",
                    findConnection.config?.url,
                );
            }
        },
        [connections, router.push, pathname, hasDisabledConnectionsByType],
    );

    const onSaveToken = async (params: {
        token: string;
        username?: string;
        email?: string;
        organizationName?: string;
        selfHostedUrl?: string;
        authMode?: AuthMode;
        integrationKey: INTEGRATIONS_KEY;
        integrationType: PlatformType;
    }) => {
        const integrationResponse = await createCodeManagementIntegration({
            integrationType: params.integrationType,
            authMode: params.authMode ?? AuthMode.TOKEN,
            token: params.token,
            host: params?.selfHostedUrl,
            username: params.username,
            email: params.email,
            orgName: params.organizationName,
            organizationAndTeamData: {
                teamId: team.uuid,
            },
        });

        switch (integrationResponse.data.status) {
            case "SUCCESS": {
                editIntegration(params.integrationKey);
                break;
            }

            case "NO_ORGANIZATION": {
                toast({
                    title: "Integration failed",
                    description:
                        "Personal accounts are not supported. Try again with an organization.",
                    variant: "danger",
                });
                break;
            }
            case "NO_REPOSITORIES": {
                toast({
                    title: "No repositories found",
                    description: (
                        <div className="mt-4">
                            <p>Possible reasons:</p>

                            <ul className="list-inside list-disc">
                                <li>No repositories in this account</li>
                                <li>Missing permissions</li>
                            </ul>
                        </div>
                    ),
                    variant: "danger",
                });
                break;
            }
        }
    };

    const openOauthOrTokenModal = async (
        integrationKey: INTEGRATIONS_KEY,
        serviceType: INTEGRATIONS_TYPES,
    ) => {
        magicModal.show(() => (
            <OauthOrTokenModal
                integration={integrationKey}
                onGoToOauth={async () => {
                    setCookie("selectedTeam", JSON.stringify(team));
                    connectIntegration(integrationKey, serviceType);
                }}
                onSaveToken={async (token, selfHostedUrl) => {
                    let integrationType: PlatformType = PlatformType.GITHUB;

                    if (integrationKey === INTEGRATIONS_KEY.GITHUB) {
                        integrationType = PlatformType.GITHUB;
                    } else if (integrationKey === INTEGRATIONS_KEY.GITLAB) {
                        integrationType = PlatformType.GITLAB;
                    }

                    await onSaveToken({
                        token,
                        selfHostedUrl,
                        integrationType,
                        integrationKey,
                    });
                }}
                showSelfHosted={
                    integrationKey === INTEGRATIONS_KEY.GITLAB ||
                    (integrationKey === INTEGRATIONS_KEY.GITHUB &&
                        githubEnterpriseServerPatEnabled)
                }
            />
        ));
    };

    const openBitbucketModal = async () => {
        magicModal.show(() => (
            <BitbucketModal
                onSave={async (
                    token,
                    username,
                    email,
                    selfHostedUrl,
                    authMode,
                ) => {
                    await onSaveToken({
                        token,
                        username,
                        email,
                        selfHostedUrl,
                        authMode,
                        integrationKey: INTEGRATIONS_KEY.BITBUCKET,
                        integrationType: PlatformType.BITBUCKET,
                    });
                }}
            />
        ));
    };

    const openAzureReposModal = async () => {
        magicModal.show(() => (
            <AzureReposModal
                onSave={async (token, organizationName) => {
                    await onSaveToken({
                        token,
                        organizationName,
                        integrationKey: INTEGRATIONS_KEY.AZURE_REPOS,
                        integrationType: PlatformType.AZURE_REPOS,
                    });
                }}
            />
        ));
    };

    const openCloneSelectTeamModal = async (
        key: string,
        serviceType: INTEGRATIONS_TYPES,
    ) => {
        const teamsResponse = await getTeamsWithIntegrations();
        if ("error" in teamsResponse) return;

        const teamSelected = await magicModal.show<true>(() => (
            <CloneSelectTeamModal
                teams={teamsResponse.data}
                category={serviceType}
                onCloneIntegration={async (teamIdToClone: string) => {
                    await cloneIntegration(team.uuid, teamIdToClone, {
                        platform: key,
                        category: serviceType,
                    });
                }}
            />
        ));

        if (!teamSelected) return;

        editIntegration(key);
    };

    const whichIntegrationMethod = async (
        key: INTEGRATIONS_KEY,
        serviceType: INTEGRATIONS_TYPES,
    ) => {
        if (key === "github" || key === "gitlab") {
            await openOauthOrTokenModal(key, serviceType);
        } else if (key === "bitbucket") {
            await openBitbucketModal();
        } else if (key === "azure_repos") {
            await openAzureReposModal();
        } else {
            setCookie("selectedTeam", JSON.stringify(team));
            await connectIntegration(key, serviceType);
        }
    };

    const handleIntegrationClick = useCallback(
        async (key: INTEGRATIONS_KEY, serviceType: INTEGRATIONS_TYPES) => {
            deleteCookie("selectedTeam");

            const hasConnectionInOrganization =
                await checkHasConnectionByPlatform({
                    platform: key,
                    category: serviceType,
                });

            const findConnection = connections.find(
                (connection) =>
                    connection.key.toLowerCase() === key.toLowerCase(),
            );

            if (!hasConnectionInOrganization) {
                await whichIntegrationMethod(key, serviceType);
                return;
            }

            if (findConnection?.hasConnection) {
                connectIntegration(key, serviceType);
            } else {
                const cloneOrNew = await magicModal.show<"clone" | "new">(
                    CloneOfferingModal,
                );
                if (!cloneOrNew) return;

                if (cloneOrNew === "clone") {
                    await openCloneSelectTeamModal(key, serviceType);
                } else if (cloneOrNew === "new") {
                    await whichIntegrationMethod(key, serviceType);
                }
            }
        },
        [connections, team, teams, connectIntegration],
    );

    const connectedPlatforms = connections.filter((c) => c.isSetupComplete);

    const connectedCodeManagementPlatform = connectedPlatforms.find(
        (c) => c.serviceType === "codeManagement",
    )?.key as keyof typeof codeManagementPlatforms;

    const wrappedConnectIntegration = (title: string, serviceType?: string) => {
        handleIntegrationClick(
            title as INTEGRATIONS_KEY, // Faz um type assertion
            serviceType as INTEGRATIONS_TYPES, // Faz um type assertion
        );
    };

    const handleDeleteIntegration = useCallback(async (title: string) => {
        setIntegrationToDelete(title);
        setShowDeleteModal(true);
    }, []);

    const confirmDeleteIntegration = useCallback(async () => {
        try {
            if (!organizationId) {
                toast({
                    variant: "danger",
                    title: "Error deleting integration",
                    description: "Organization ID is missing. Cannot proceed.",
                });
                setShowDeleteModal(false);
                setIntegrationToDelete("");
                return;
            }

            await deleteIntegration(team.uuid);

            toast({
                variant: "success",
                title: "Integration deleted successfully",
            });

            await invalidateQueries({
                type: "all",
                queryKey: generateQueryKey(
                    INTEGRATION_CONFIG.GET_INTEGRATION_CONFIG_BY_CATEGORY,
                    {
                        params: {
                            teamId: team.uuid,
                            integrationCategory:
                                IntegrationCategory.CODE_MANAGEMENT,
                        },
                    },
                ),
            });

            // Invalidate all queries related to integrations
            await invalidateQueries({
                type: "all",
                queryKey: ["integrations"],
            });

            // Invalidate team queries
            await invalidateQueries({
                type: "all",
                queryKey: ["teams"],
            });

            setShowDeleteModal(false);
            setIntegrationToDelete("");
        } catch (error) {
            toast({
                variant: "warning",
                title: "Error deleting integration",
                description: "Please try again later",
            });
        }
    }, [
        organizationId,
        team.uuid,
        invalidateQueries,
        generateQueryKey,
        router,
    ]);

    return (
        <>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                <div>
                    <TextTopIntegrations serviceType="codeManagement" />

                    {connectedCodeManagementPlatform ? (
                        <CardConnection
                            integrationKey={connectedCodeManagementPlatform}
                            svg={
                                codeManagementPlatforms[
                                    connectedCodeManagementPlatform
                                ].svg
                            }
                            title={
                                codeManagementPlatforms[
                                    connectedCodeManagementPlatform
                                ].platformName
                            }
                            isSetupComplete={true}
                            connectIntegration={wrappedConnectIntegration}
                            editIntegration={editIntegration}
                            deleteIntegration={handleDeleteIntegration}
                        />
                    ) : (
                        <div className="flex h-full flex-col gap-2 md:min-h-[220px]">
                            {Object.entries(codeManagementPlatforms).map(
                                ([key, connection]) => {
                                    return (
                                        <IntegrationCard
                                            key={key}
                                            connection={{
                                                platformName:
                                                    connection.platformName,
                                                svg: connection.svg,
                                            }}
                                            onClick={() => {
                                                handleIntegrationClick(
                                                    key as INTEGRATIONS_KEY,
                                                    "codeManagement",
                                                );
                                            }}
                                        />
                                    );
                                },
                            )}
                        </div>
                    )}
                </div>
            </div>

            {showDeleteModal && (
                <DeleteIntegrationModal
                    title={integrationToDelete}
                    onConfirm={confirmDeleteIntegration}
                    onCancel={() => {
                        setShowDeleteModal(false);
                        setIntegrationToDelete("");
                    }}
                />
            )}
        </>
    );
}

const IntegrationCard = (props: {
    connection: { platformName: string; svg: React.ReactNode };
    onClick: () => void;
    disabled?: boolean;
}) => {
    return (
        <Button
            size="lg"
            variant="helper"
            className="h-20 w-full justify-start"
            onClick={() => props.onClick()}
            disabled={props.disabled}
            leftIcon={
                <span className="*:size-8!">{props.connection.svg}</span>
            }>
            <Heading variant="h2">{props.connection.platformName}</Heading>
        </Button>
    );
};
