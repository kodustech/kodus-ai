"use client";

import { Alert, AlertDescription } from "@components/ui/alert";
import { useOptionalParameterQuery } from "@services/parameters/hooks";
import {
    ParametersConfigKey,
    type CentralizedConfigValue,
} from "@services/parameters/types";
import { AlertCircleIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { useFeatureFlags } from "../../_components/context";
import { useCodeReviewRouteParams } from "../../_hooks";

const readOnlyPages = new Set([
    "general",
    "review-categories",
    "custom-prompts",
    "suggestion-control",
    "pr-summary",
    "kody-rules",
]);

export function CentralizedConfigReadOnlyAlert() {
    const { teamId } = useSelectedTeamId();
    const { centralizedConfigParameter } = useFeatureFlags();
    const { pageName } = useCodeReviewRouteParams();

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

    const showReadOnlyAlert =
        centralizedConfigParameter === true &&
        centralizedConfig.data?.configValue?.enabled === true &&
        readOnlyPages.has(pageName);

    if (!showReadOnlyAlert) return null;

    return (
        <Alert variant="warning">
            <AlertCircleIcon />
            <AlertDescription className="text-pretty">
                Centralized config is enabled. Code review parameter fields on
                this page are read-only and controlled by the {repositoryName}{" "}
                repository.
            </AlertDescription>
        </Alert>
    );
}
