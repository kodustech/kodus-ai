"use client";

import { useEffect, useMemo, useState } from "react";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { useIssueCreationConfig } from "@services/issues/hooks";
import type { IssueCreationConfigResponse } from "@services/issues/types";
import { PARAMETERS_PATHS } from "@services/parameters";
import { createOrUpdateParameter } from "@services/parameters/fetch";
import { ParametersConfigKey } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useQueryClient } from "@tanstack/react-query";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { generateQueryKey } from "src/core/utils/reactQuery";

const normalizeConfigValue = (
    value: IssueCreationConfigResponse["configValue"] | undefined,
): boolean => {
    if (typeof value === "boolean") return value;

    if (value && typeof value === "object") {
        const maybeEnabled = (value as { enabled?: boolean }).enabled;
        if (typeof maybeEnabled === "boolean") return maybeEnabled;
    }

    return true;
};

export const IssueCreationToggle = () => {
    const { teamId } = useSelectedTeamId();
    const queryClient = useQueryClient();
    const canUpdateIssues = usePermission(Action.Update, ResourceType.Issues);

    const issueCreationQuery = useIssueCreationConfig(teamId);
    const { isLoading, isFetching, error, data } = issueCreationQuery;

    const normalizedValue = useMemo(
        () => normalizeConfigValue(data?.configValue),
        [data?.configValue],
    );

    const [localEnabled, setLocalEnabled] = useState<boolean>(true);

    useEffect(() => {
        setLocalEnabled(normalizedValue);
    }, [normalizedValue]);

    useEffect(() => {
        if (error) {
            console.error("Failed to load issue creation config", error);
            setLocalEnabled(true);
        }
    }, [error]);

    const [updateIssueCreationConfig, { loading: isUpdating }] = useAsyncAction(
        async (params: { nextValue: boolean; previousValue: boolean }) => {
            const { nextValue, previousValue } = params;

            if (!teamId) return;

            try {
                const result = await createOrUpdateParameter(
                    ParametersConfigKey.ISSUE_CREATION_CONFIG,
                    nextValue,
                    teamId,
                );

                if ((result as { error?: unknown })?.error) {
                    throw new Error(
                        String((result as { error?: unknown }).error),
                    );
                }

                queryClient.setQueryData<IssueCreationConfigResponse>(
                    generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                        params: {
                            key: ParametersConfigKey.ISSUE_CREATION_CONFIG,
                            teamId,
                        },
                    }),
                    (old) =>
                        old
                            ? { ...old, configValue: nextValue }
                            : {
                                  uuid: "",
                                  configKey:
                                      ParametersConfigKey.ISSUE_CREATION_CONFIG,
                                  configValue: nextValue,
                              },
                );
            } catch (err) {
                console.error("Failed to update issue creation config", err);
                setLocalEnabled(previousValue);
                toast({
                    title: "Failed to update",
                    description:
                        "We couldn't update automatic issue creation. Please try again.",
                    variant: "danger",
                });
            }
        },
    );

    const isDisabled = !teamId || !canUpdateIssues || isLoading || isFetching;

    return (
        <div className="text-text-secondary flex items-center gap-2 text-sm">
            <span className="text-text-primary font-medium">
                Auto-create issues
            </span>
            <Switch
                size="sm"
                role="switch"
                aria-label="Toggle automatic issue creation"
                checked={localEnabled}
                disabled={isDisabled}
                loading={isUpdating}
                onCheckedChange={(checked) => {
                    if (isDisabled) return;
                    const previousValue = localEnabled;
                    setLocalEnabled(checked);
                    updateIssueCreationConfig({
                        nextValue: checked,
                        previousValue,
                    });
                }}
            />
        </div>
    );
};
