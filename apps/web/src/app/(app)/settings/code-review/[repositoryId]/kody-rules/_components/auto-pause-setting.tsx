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
import { isCockpitTierAllowed } from "src/features/ee/cockpit/_helpers/tier-policy";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";

import { getCentralizedPrToastPayload } from "../../../_utils/centralized-pr-feedback";
import { useCodeReviewConfig } from "../../../../_components/context";
import { useCodeReviewRouteParams } from "../../../../_hooks";

/**
 * `kodyRulesAutoPauseEnabled`: a daily job pauses the rules Cockpit labels
 * ignored or noisy. Hidden on plans without Cockpit, where it would do nothing.
 */
export const KodyRulesAutoPauseSetting = () => {
    const config = useCodeReviewConfig();
    const { license } = useSubscriptionContext();
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { invalidateQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();

    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );

    const currentValue = config?.kodyRulesAutoPauseEnabled?.value ?? false;

    const [handleToggle, { loading }] = useAsyncAction(async () => {
        try {
            const mutationResult = await createOrUpdateCodeReviewParameter(
                { kodyRulesAutoPauseEnabled: !currentValue },
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
                        { params: { teamId } },
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

    if (!isCockpitTierAllowed(license)) return null;

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
                                        Pause ignored and noisy rules
                                    </Section.Title>
                                    {config?.kodyRulesAutoPauseEnabled && (
                                        <OverrideIndicator
                                            initialState={
                                                config.kodyRulesAutoPauseEnabled
                                            }
                                            currentValue={currentValue}
                                            handleRevert={() => handleToggle()}
                                        />
                                    )}
                                </div>
                            </Section.Header>

                            <Section.Content className="text-text-secondary text-sm font-normal">
                                Once a day, Kody pauses any active rule in this
                                scope that developers ignore (20% or less of its
                                suggestions implemented) or downvote, over the
                                last 30 days. This includes rules written by
                                hand. Admins get notified and can resume a rule
                                at any time.
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
