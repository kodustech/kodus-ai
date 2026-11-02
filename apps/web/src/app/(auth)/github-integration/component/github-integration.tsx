"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@components/ui/button";
import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { ORGANIZATIONS_PATHS } from "@services/organizations";
import { createCodeManagementIntegration } from "@services/codeManagement/fetch";
import { useGetGithubIntegrationByInstallId } from "@services/setup/hooks";
import { InstallationStatus } from "@services/setup/types";
import { AxiosError } from "axios";
import { getCookie, deleteCookie } from "cookies-next/client";
import { CopyIcon } from "lucide-react";
import {
    GITHUB_CODE_PARAM,
    GITHUB_STATE_PARAM,
    githubAuthorizationReturnPath,
    startGithubInstallationAuthorization,
} from "src/core/integrations/github-installation-authorization";
import { PlatformType } from "src/core/types";
import { axiosAuthorized } from "src/core/utils/axios";

type Step = "checking" | "creating" | "success" | "needs-login" | "failed";

export default function GithubIntegrationClient() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const installationId = searchParams.get("installation_id");
    // GitHub's user authorization sends `code` and `state` back here; the
    // page that started it gets them as github_code and github_state.
    const returnedCode = searchParams.get("code");
    const returnedState = searchParams.get("state");
    const githubCode = searchParams.get(GITHUB_CODE_PARAM);
    const githubState = searchParams.get(GITHUB_STATE_PARAM);

    const { data, isLoading, error } = useGetGithubIntegrationByInstallId(
        installationId ?? "",
    );

    const [step, setStep] = useState<Step>("checking");
    const [organizationName, setOrganizationName] = useState<string | undefined>();
    const [failureMessage, setFailureMessage] = useState<string | undefined>();
    const creatingRef = useRef(false);
    // githubAuthorizationReturnPath consumes the saved return path, and the
    // effect below runs again whenever the lookup settles before the
    // navigation lands: send the user back once, or the second run loses
    // the return path and the installation id.
    const returningRef = useRef(false);

    function loginToDoIntegration() {
        router.push(`/setup/github?installation_id=${installationId}`);
    }

    function copyLink() {
        navigator.clipboard.writeText(
            `${window.location.origin}/setup/github?installation_id=${installationId}`,
        );

        toast({
            title: "Copied to clipboard",
            variant: "info",
        });
    }

    useEffect(() => {
        if (returnedCode && returnedState && !githubCode) {
            if (!returningRef.current) {
                returningRef.current = true;
                router.replace(
                    githubAuthorizationReturnPath(returnedCode, returnedState),
                );
            }
            return;
        }

        if (!installationId) {
            setStep("failed");
            return;
        }
        if (isLoading) return;

        if (data?.status === InstallationStatus.SUCCESS) {
            setStep("success");
            return;
        }

        if (error) {
            setStep("failed");
            return;
        }

        if (creatingRef.current) return;

        const teamCookie = getCookie("selectedTeam");
        const team = (() => {
            if (!teamCookie || typeof teamCookie !== "string") return null;
            try {
                return JSON.parse(teamCookie) as { uuid?: string; name?: string };
            } catch {
                return null;
            }
        })();

        if (!team?.uuid) {
            // The onboarding starts the install without a selected team: the
            // setup page links it to the team being set up.
            if (getCookie("started-setup-from-new-setup-page")) {
                router.replace(
                    `/setup/github?installation_id=${encodeURIComponent(installationId)}`,
                );
                return;
            }
            setStep("needs-login");
            return;
        }

        creatingRef.current = true;
        setStep("creating");

        if (!githubCode || !githubState) {
            startGithubInstallationAuthorization(
                installationId,
                `/github-integration?installation_id=${encodeURIComponent(installationId)}`,
            ).catch((err) => {
                console.error("[GithubIntegration] authorization failed", err);
                setStep("failed");
                creatingRef.current = false;
            });
            return;
        }

        (async () => {
            try {
                const orgIdResp = await axiosAuthorized.fetcher<string>(
                    ORGANIZATIONS_PATHS.ORGANIZATION_ID,
                );
                const organizationId =
                    typeof orgIdResp === "string"
                        ? orgIdResp
                        : ((orgIdResp as { data?: string })?.data ?? "");

                if (!organizationId) {
                    setStep("needs-login");
                    creatingRef.current = false;
                    return;
                }

                const response = await createCodeManagementIntegration({
                    integrationType: PlatformType.GITHUB,
                    installationId,
                    githubCode,
                    githubState,
                    organizationAndTeamData: {
                        organizationId,
                        teamId: team.uuid!,
                    },
                });

                const status = response?.data?.status;

                if (status === "SUCCESS") {
                    setOrganizationName(team.name);
                    setStep("success");
                    deleteCookie("selectedTeam");
                    router.replace("/settings/git/repositories");
                    return;
                }

                if (status === "NO_ORGANIZATION") {
                    toast({
                        title: "Integration with GitHub failed",
                        description:
                            "Personal accounts are not supported. Try again with an organization.",
                        variant: "warning",
                    });
                    setStep("failed");
                    return;
                }

                if (status === "NO_REPOSITORIES") {
                    toast({
                        title: "No repositories found in GitHub",
                        description:
                            "No repositories are visible to the installation, or permissions are missing.",
                        variant: "warning",
                    });
                    setStep("failed");
                    return;
                }

                setStep("failed");
            } catch (err) {
                console.error("[GithubIntegration] failed to create", err);
                if (err instanceof AxiosError) {
                    const backendMessage = (err.response?.data as {
                        message?: string;
                    })?.message;
                    setFailureMessage(backendMessage);
                }
                setStep("failed");
            } finally {
                creatingRef.current = false;
            }
        })();
    }, [
        data,
        error,
        installationId,
        isLoading,
        router,
        returnedCode,
        returnedState,
        githubCode,
        githubState,
    ]);

    if (step === "checking" || step === "creating" || isLoading) {
        return (
            <div className="flex h-full w-full items-center justify-center">
                <Spinner />
            </div>
        );
    }

    if (step === "success") {
        return (
            <div className="flex h-full w-full items-center justify-center">
                <Card className="w-lg">
                    <CardHeader>
                        <CardTitle>
                            {organizationName ? (
                                <>
                                    GitHub integration with{" "}
                                    <span className="text-primary-light">
                                        {organizationName}
                                    </span>{" "}
                                    successfully completed!
                                </>
                            ) : (
                                "GitHub integration successfully completed!"
                            )}
                        </CardTitle>
                    </CardHeader>

                    <CardContent>
                        <p className="text-text-secondary text-sm">
                            You can now close this window.
                        </p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (step === "failed") {
        return (
            <div className="flex h-full w-full items-center justify-center">
                <Card className="w-lg">
                    <CardHeader>
                        <CardTitle>
                            The GitHub integration could not be completed.
                        </CardTitle>
                    </CardHeader>

                    <CardContent>
                        <p className="text-text-secondary text-sm">
                            {failureMessage ??
                                "We could not finish the installation handshake. Try again in a moment, or contact support if it persists."}
                        </p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="flex h-full w-full items-center justify-center">
            <Card className="w-lg">
                <CardHeader>
                    <CardTitle>
                        The automatic integration could not be completed.
                    </CardTitle>
                </CardHeader>

                <CardContent>
                    <p className="text-text-secondary text-sm">
                        Click the button below to log in with the account that
                        requested the integration, or copy the link and send it
                        to the person responsible for the account.
                    </p>
                </CardContent>

                <CardFooter className="justify-between">
                    <Button
                        size="md"
                        variant="cancel"
                        className="px-0"
                        leftIcon={<CopyIcon />}
                        onClick={copyLink}>
                        Copy link
                    </Button>

                    <Button
                        size="md"
                        variant="primary"
                        onClick={loginToDoIntegration}>
                        Login
                    </Button>
                </CardFooter>
            </Card>
        </div>
    );
}
