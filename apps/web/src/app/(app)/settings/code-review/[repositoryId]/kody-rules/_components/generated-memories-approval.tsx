"use client";

import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { Section } from "@components/ui/section";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { PARAMETERS_PATHS } from "@services/parameters";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import {
    isCentralizedPrResponse,
    ParametersConfigKey,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { OverrideIndicator } from "src/app/(app)/settings/code-review/_components/override";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { getCentralizedPrToastPayload } from "../../../_utils/centralized-pr-feedback";
import { useCodeReviewConfig } from "../../../../_components/context";
import { useCodeReviewRouteParams } from "../../../../_hooks";

export const GeneratedMemoriesApprovalSetting = () => {
    const config = useCodeReviewConfig();
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { invalidateQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();

    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );

    const currentValue =
        config?.llmGeneratedMemoriesRequireApproval?.value ?? false;

    const [handleToggle, { loading }] = useAsyncAction(async () => {
        try {
            const mutationResult = await createOrUpdateCodeReviewParameter(
                {
                    llmGeneratedMemoriesRequireApproval: !currentValue,
                },
                teamId,
                repositoryId,
                directoryId,
            );

            if (isCentralizedPrResponse(mutationResult)) {
                toast(
                    getCentralizedPrToastPayload(
                        mutationResult,
                        "Change proposed through centralized pull request.",
                    ),
                );
                return;
            }

            await Promise.all([
                invalidateQueries({
                    queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                        params: {
                            key: ParametersConfigKey.CODE_REVIEW_CONFIG,
                            teamId,
                        },
                    }),
                }),
                invalidateQueries({
                    queryKey: generateQueryKey(
                        PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
                        {
                            params: { teamId },
                        },
                    ),
                }),
            ]);

            toast({ description: "Settings saved", variant: "success" });
        } catch (error) {
            console.error("Error saving settings:", error);

            toast({
                title: "Error",
                description:
                    "An error occurred while saving the settings. Please try again.",
                variant: "danger",
            });
        }
    });

    const handleRevert = () => {
        handleToggle();
    };

    return (
        <Button
            size="lg"
            variant="helper"
            className="w-full justify-between p-0"
            disabled={!canEdit || loading}
            onClick={() => handleToggle()}>
            <Card color="none" className="w-full">
                <CardHeader>
                    <div className="flex items-center justify-between gap-20">
                        <Section.Root>
                            <Section.Header>
                                <div className="flex items-center gap-2">
                                    <Section.Title>
                                        LLM-generated memories approval
                                    </Section.Title>
                                    {config?.llmGeneratedMemoriesRequireApproval !==
                                        undefined && (
                                        <OverrideIndicator
                                            initialState={
                                                config.llmGeneratedMemoriesRequireApproval
                                            }
                                            currentValue={currentValue}
                                            handleRevert={handleRevert}
                                        />
                                    )}
                                </div>
                            </Section.Header>

                            <Section.Content className="text-text-secondary text-sm font-normal">
                                When enabled, LLM-generated memories are created
                                as pending and require approval before becoming
                                active. When disabled, generated memories are
                                active by default.
                            </Section.Content>
                        </Section.Root>

                        <Switch
                            decorative
                            loading={loading}
                            checked={currentValue}
                        />
                    </div>
                </CardHeader>
            </Card>
        </Button>
    );
};
