"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@components/ui/button";
import {
    Card,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { INTEGRATIONS_KEY } from "@enums";
import { useEffectOnce } from "@hooks/use-effect-once";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { createCodeManagementIntegration } from "@services/codeManagement/fetch";
import { SETUP_PATHS } from "@services/setup";
import { useGetGithubOrganizationName } from "@services/setup/hooks";
import { deleteCookie, getCookie } from "cookies-next";
import { SaveIcon } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { PlatformType } from "src/core/types";
import { ClientSideCookieHelpers } from "src/core/utils/cookie";
import { useOrganizationContext } from "src/features/organization/_providers/organization-context";

type Integration = (typeof INTEGRATIONS_KEY)[keyof typeof INTEGRATIONS_KEY];

export default function Redirect() {
    const [integration, setIntegration] = useState<Integration | "">("");
    const [showConfirmation, setShowConfirmation] = useState(false);
    const [selectedTeam, setSelectedTeam] = useState<string>("");
    const [selectedTeamName, setSelectedTeamName] = useState<string | null>(
        null,
    ); // Novo estado para o nome do time
    const [isIntegrating, setIsIntegrating] = useState<boolean>(false); // Novo estado para controlar a integração

    const [inputText, setInputText] = useState<string>("");
    const [error, setError] = useState<boolean>(false);
    const [hasMounted, setHasMounted] = useState(false);
    const searchParams = useSearchParams();

    const { data: organizationName } = useGetGithubOrganizationName();
    const { organizationId } = useOrganizationContext();
    const { teamId } = useSelectedTeamId();

    const params = useParams<{ id: string }>();
    const router = useRouter();
    const { removeQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();

    const { userId } = useAuth();

    const isSetup = useMemo(
        () =>
            ClientSideCookieHelpers("started-setup-from-new-setup-page").has(),
        [],
    );

    useEffectOnce(() => {
        ClientSideCookieHelpers("started-setup-from-new-setup-page").delete();
    });

    useEffect(() => {
        setHasMounted(true);
    }, []);

    const code = searchParams.get("code");
    const installationId = searchParams.get("installation_id");

    useEffect(() => {
        const id =
            params.id as (typeof INTEGRATIONS_KEY)[keyof typeof INTEGRATIONS_KEY];

        if (id && Object.values(INTEGRATIONS_KEY).includes(id)) {
            setIntegration(id);
        } else {
            setError(true);
        }
    }, [params]);

    useEffect(() => {
        if (hasMounted) {
            const selectedTeamCookie = getCookie("selectedTeam") as any;
            const savedTeam =
                selectedTeamCookie &&
                selectedTeamCookie !== "undefined" &&
                selectedTeamCookie !== ""
                    ? (JSON.parse(selectedTeamCookie) as any)
                    : null;

            if (
                savedTeam &&
                savedTeam?.uuid &&
                organizationId &&
                integration &&
                (code || installationId)
            ) {
                setSelectedTeam(savedTeam.uuid);
                setSelectedTeamName(savedTeam.name);
                setShowConfirmation(true);
            } else if (
                teamId &&
                organizationId &&
                integration &&
                (code || installationId)
            ) {
                setShowConfirmation(false);
                setIsIntegrating(true);
                newIntegration();
            }
        }
    }, [
        teamId,
        code,
        installationId,
        integration,
        router,
        organizationId,
        hasMounted,
    ]);

    useEffect(() => {
        if (organizationName) {
            setInputText(organizationName);
        }
    }, [organizationName]);

    const redirectToConfiguration = async (
        integrationKey: Integration,
        teamId: string,
    ) => {
        if (isSetup) {
            removeQueries({
                queryKey: generateQueryKey(SETUP_PATHS.CONNECTIONS),
            });

            return router.replace(`/setup/choosing-repositories`);
        }

        deleteCookie("selectedTeam", { path: "/" });

        ClientSideCookieHelpers("global-selected-team-id").set(teamId);

        router.replace("/settings/git/repositories");
    };

    const newIntegration = async () => {
        let integrationResponse: any;
        const organizationAndTeamData = {
            organizationId,
            teamId: selectedTeam || teamId,
        };

        if (integration === INTEGRATIONS_KEY.GITHUB) {
            if (organizationId) {
                integrationResponse = await createCodeManagementIntegration({
                    integrationType: PlatformType.GITHUB,
                    code,
                    organizationAndTeamData,
                    installationId,
                });
            }
        } else if (integration === INTEGRATIONS_KEY.GITLAB) {
            if (organizationId) {
                integrationResponse = await createCodeManagementIntegration({
                    code,
                    integrationType: PlatformType.GITLAB,
                    organizationAndTeamData,
                });
            }
        }

        switch (integration) {
            case INTEGRATIONS_KEY.GITHUB: {
                switch (
                    (
                        integrationResponse as Awaited<
                            ReturnType<typeof createCodeManagementIntegration>
                        >
                    ).data.status
                ) {
                    case "SUCCESS": {
                        await redirectToConfiguration(
                            INTEGRATIONS_KEY.GITHUB,
                            selectedTeam,
                        );
                        break;
                    }

                    case "NO_ORGANIZATION": {
                        if (isSetup) {
                            router.replace(
                                "/setup/organization-account-required",
                            );
                        } else {
                            toast({
                                title: "Integration with Github failed",
                                description:
                                    "Personal accounts are not supported. Try again with an organization.",
                                variant: "warning",
                            });

                            cancelIntegration();
                        }
                        break;
                    }
                    case "NO_REPOSITORIES": {
                        if (isSetup) {
                            router.replace("/setup/no-repositories");
                        } else {
                            toast({
                                title: "No repositories found in Github",
                                description: (
                                    <div className="mt-4">
                                        <p>Possible reasons:</p>

                                        <ul className="list-inside list-disc">
                                            <li>
                                                No repositories in this account
                                            </li>
                                            <li>Missing permissions</li>
                                        </ul>
                                    </div>
                                ),
                                variant: "warning",
                            });

                            cancelIntegration();
                        }
                        break;
                    }
                }
            }

            case INTEGRATIONS_KEY.GITLAB: {
                switch (
                    (
                        integrationResponse as Awaited<
                            ReturnType<typeof createCodeManagementIntegration>
                        >
                    ).data.status
                ) {
                    case "SUCCESS": {
                        await redirectToConfiguration(
                            INTEGRATIONS_KEY.GITLAB,
                            selectedTeam,
                        );
                        break;
                    }

                    case "NO_ORGANIZATION": {
                        if (isSetup) {
                            router.replace(
                                "/setup/organization-account-required",
                            );
                        } else {
                            toast({
                                title: "Integration with Gitlab failed",
                                description:
                                    "Personal accounts are not supported. Try again with an organization.",
                                variant: "warning",
                            });

                            cancelIntegration();
                        }
                        break;
                    }
                    case "NO_REPOSITORIES": {
                        if (isSetup) {
                            router.replace("/setup/no-repositories");
                        } else {
                            toast({
                                title: "No repositories found in Gitlab",
                                description: (
                                    <div className="mt-4">
                                        <p>Possible reasons:</p>

                                        <ul className="list-inside list-disc">
                                            <li>
                                                No repositories in this account
                                            </li>
                                            <li>Missing permissions</li>
                                        </ul>
                                    </div>
                                ),
                                variant: "warning",
                            });

                            cancelIntegration();
                        }
                        break;
                    }
                }
            }

            case INTEGRATIONS_KEY.AZURE_REPOS:
                if (integrationResponse?.success) {
                    await redirectToConfiguration(
                        INTEGRATIONS_KEY.AZURE_REPOS,
                        selectedTeam,
                    );
                }
                break;

            default:
                setError(true);
        }
    };

    const handleConfirmIntegration = () => {
        setIsIntegrating(true);
        newIntegration();
        setShowConfirmation(false);
    };

    if (!hasMounted) {
        return (
            <div className="flex h-screen w-screen items-center justify-center">
                <Spinner />
            </div>
        );
    }

    const cancelIntegration = () => {
        setShowConfirmation(false);
        deleteCookie("selectedTeam", { path: "/" });
        ClientSideCookieHelpers("global-selected-team-id").set(teamId);
        router.replace(`/settings/git`);
    };

    return (
        <Suspense>
            {(() => {
                if (isIntegrating && integration) {
                    return (
                        <Page.Root>
                            <Page.Content className="flex-row items-center justify-center">
                                <Spinner />
                                Connecting {integration.toUpperCase()}...
                            </Page.Content>
                        </Page.Root>
                    );
                }

                if (showConfirmation) {
                    return (
                        <div className="flex h-screen w-screen items-center justify-center">
                            <Card className="w-lg gap-6 p-2 pb-2">
                                <CardHeader>
                                    <CardTitle>Confirm Integration</CardTitle>
                                    <CardDescription>
                                        Are you sure you want to proceed with
                                        the integration of{" "}
                                        <strong className="text-primary-light">
                                            {integration.toUpperCase()}
                                        </strong>{" "}
                                        for the team{" "}
                                        <strong className="text-primary-light">
                                            {selectedTeamName}
                                        </strong>
                                        ?
                                    </CardDescription>
                                </CardHeader>

                                <CardFooter className="flex justify-end gap-4">
                                    <Button
                                        size="md"
                                        variant="cancel"
                                        onClick={() => cancelIntegration()}>
                                        Cancel
                                    </Button>

                                    <Button
                                        size="md"
                                        variant="primary"
                                        leftIcon={<SaveIcon />}
                                        onClick={handleConfirmIntegration}>
                                        Save Integration
                                    </Button>
                                </CardFooter>
                            </Card>
                        </div>
                    );
                }

                if (error) {
                    return (
                        <div>
                            <span>Error to connect</span>
                        </div>
                    );
                }
            })()}
        </Suspense>
    );
}
