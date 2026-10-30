"use client";

import { Alert, AlertDescription } from "@components/ui/alert";
import { Link } from "@components/ui/link";
import { useOptionalParameterQuery } from "@services/parameters/hooks";
import {
    ParametersConfigKey,
    type CentralizedConfigValue,
} from "@services/parameters/types";
import { AlertCircleIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

export function CentralizedConfigReadOnlyAlert() {
    const { teamId } = useSelectedTeamId();

    const centralizedConfig = useOptionalParameterQuery<CentralizedConfigValue>(
        ParametersConfigKey.CENTRALIZED_CONFIG,
        teamId,
        {
            uuid: "",
            configKey: ParametersConfigKey.CENTRALIZED_CONFIG,
            configValue: {
                enabled: false,
                repository: {
                    id: "",
                    name: "",
                },
            },
        },
    );

    const repositoryName =
        centralizedConfig.data?.configValue?.repository?.name?.trim() ||
        "configured";
    const activePullRequestUrl =
        centralizedConfig.data?.configValue?.activePullRequest?.prUrl;

    const showCentralizedAlert =
        centralizedConfig.data?.configValue?.enabled === true;

    if (!showCentralizedAlert) return null;

    return (
        <Alert variant="warning">
            <AlertCircleIcon />
            <AlertDescription className="text-pretty">
                Centralized config is enabled. Changes on this page are saved
                immediately and proposed through pull requests in the{" "}
                {repositoryName} repository. Synchronization reapplies the
                configuration from that repository.
                {activePullRequestUrl ? (
                    <>
                        {" "}
                        <Link href={activePullRequestUrl} target="_blank">
                            View active pull request
                        </Link>
                        .
                    </>
                ) : null}
            </AlertDescription>
        </Alert>
    );
}
