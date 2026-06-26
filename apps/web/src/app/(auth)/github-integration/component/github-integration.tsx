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
import { getCookie, deleteCookie } from "cookies-next";
import { CopyIcon } from "lucide-react";
import { PlatformType } from "src/core/types";
import { axiosAuthorized } from "src/core/utils/axios";

type Step = "checking" | "creating" | "success" | "needs-login" | "failed";

export default function GithubIntegrationClient() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const installationId = searchParams.get("installation_id");

    const { data, isLoading, error } = useGetGithubIntegrationByInstallId(
        installationId ?? "",
    );

    const [step, setStep] = useState<Step>("checking");
    const [organizationName, setOrganizationName] = useState<string | undefined>();
    const [failureMessage, setFailureMessage] = useState<string | undefined>();
    const creatingRef = useRef(false);

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
        if (!installationId) {
            setStep("failed");
            return;
        }
        if (isLoading) return;

        if (data?.status === InstallationStatus.SUCCESS) {
            setOrganizationName(data.organizationName);
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
            setStep("needs-login");
            return;
        }

        creatingRef.current = true;
        setStep("creating");

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
    }, [data, error, installationId, isLoading, router]);

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
                            GitHub integration with{" "}
                            <span className="text-primary-light">
                                {organizationName ?? data?.organizationName}
                            </span>{" "}
                            successfully completed!
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
