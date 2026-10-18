"use client";

import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { InlineCode } from "@components/ui/inline-code";
import { Link } from "@components/ui/link";
import { Section } from "@components/ui/section";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { useConfig } from "@providers/ConfigProvider";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import { syncIDERules } from "@services/kodyRules/fetch";
import { useSuspenseKodyRulesCheckSyncStatus } from "@services/kodyRules/hooks";
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

import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import { useCodeReviewConfig } from "../../../_components/context";
import { useCodeReviewRouteParams } from "../../../_hooks";
import { ExcludedReviewersPicker } from "./excluded-reviewers-picker";

export const GenerateRulesOptions = () => {
    const cfg = useConfig();
    const config = useCodeReviewConfig();
    const { teamId } = useSelectedTeamId();
    const { repositoryId } = useCodeReviewRouteParams();
    // At global level these toggles are the default every repository without
    // its own value follows. A global flip runs no one-off work: the weekly
    // cron backfills newly enabled generators.
    const isGlobal = repositoryId === "global";
    const { invalidateQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();
    const syncStatus = useSuspenseKodyRulesCheckSyncStatus({
        teamId,
        repositoryId,
    });
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );

    const [
        handleGenerateFromPastReviewsToggle,
        { loading: isLoadingGenerateFromPastReviewsToggle },
    ] = useAsyncAction(async () => {
        try {
            const newValue = !config?.kodyRulesGeneratorEnabled?.value;

            const mutationResult = await createOrUpdateCodeReviewParameter(
                {
                    kodyRulesGeneratorEnabled: newValue,
                },
                teamId,
                repositoryId,
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

            invalidateQueries({
                queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                    params: {
                        key: ParametersConfigKey.CODE_REVIEW_CONFIG,
                        teamId,
                    },
                }),
            });

            invalidateQueries({
                queryKey: generateQueryKey(KODY_RULES_PATHS.CHECK_SYNC_STATUS, {
                    params: { teamId, repositoryId },
                }),
            });

            invalidateQueries({
                queryKey: generateQueryKey(
                    PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
                    {
                        params: { teamId },
                    },
                ),
            });

            toast({ description: "Settings saved", variant: "success" });

            // A global save starts nothing; repositories that follow it are
            // picked up by the weekly run, which backfills 3 months.
            if (isGlobal && newValue) {
                toast({
                    variant: "info",
                    title: "Learning starts on the next weekly run",
                    description:
                        "Repositories that follow this setting get rules drafted from their last 3 months of closed PRs when Kody's weekly learning run comes around.",
                });
            }

            // First time this repo's generator is enabled, the backend seeds its
            // rules from the last 3 months of closed PRs (the weekly cron only
            // looks at the last week). Let the user know it's running.
            if (
                !isGlobal &&
                syncStatus.kodyRulesGeneratorEnabledFirstTime &&
                newValue
            ) {
                toast({
                    variant: "info",
                    title: "We're analyzing your past PRs",
                    description:
                        "Kody is reviewing the last 3 months of closed PRs to draft rules. This may take a few minutes; generated rules will appear on this page.",
                });

                invalidateQueries({
                    queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                        params: {
                            teamId,
                            key: ParametersConfigKey.PLATFORM_CONFIGS,
                        },
                    }),
                });
            }
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

    const [handleImportRuleFiles, { loading: isImportingRuleFiles }] =
        useAsyncAction(async () => {
            try {
                await syncIDERules({ teamId, repositoryId });
                toast({
                    variant: "info",
                    title: "Importing rule files",
                    description:
                        "Kody is reading this repository's .kody/rules files. Imported rules will appear on this page in a minute.",
                });
                invalidateQueries({
                    queryKey: generateQueryKey(
                        KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER,
                        { params: { repositoryId } },
                    ),
                });
            } catch (error) {
                console.error("Error importing rule files:", error);
                toast({
                    title: "Error",
                    description:
                        "We couldn't start the import. Please try again.",
                    variant: "danger",
                });
            }
        });

    return (
        <div className="flex flex-col gap-2">
            <span className="text-text-secondary mb-2 ml-2 text-xs">
                <span>
                    Rule files in{" "}
                    <InlineCode className="bg-card-lv1">.kody/rules</InlineCode>{" "}
                    are always kept in sync.{" "}
                </span>
                <Link href={cfg.ruleFilesDocs || ""}>Check the docs</Link>
                {!isGlobal && canEdit && (
                    <>
                        {" · "}
                        <button
                            type="button"
                            className="text-primary-light hover:underline disabled:opacity-50"
                            disabled={isImportingRuleFiles}
                            onClick={() => handleImportRuleFiles()}>
                            Import rule files now
                        </button>
                    </>
                )}
            </span>

            <Button
                size="lg"
                variant="helper"
                className="w-full justify-between p-0"
                disabled={!canEdit}
                onClick={() => handleGenerateFromPastReviewsToggle()}>
                <Card color="none" className="w-full">
                    <CardHeader>
                        <div className="flex items-center justify-between gap-20">
                            <Section.Root>
                                <Section.Header>
                                    <div className="flex items-center gap-2">
                                        <Section.Title>
                                            Generate from past reviews
                                        </Section.Title>
                                        {config?.kodyRulesGeneratorEnabled && (
                                            <OverrideIndicator
                                                initialState={
                                                    config.kodyRulesGeneratorEnabled
                                                }
                                                currentValue={
                                                    config
                                                        .kodyRulesGeneratorEnabled
                                                        .value
                                                }
                                                handleRevert={
                                                    handleGenerateFromPastReviewsToggle
                                                }
                                            />
                                        )}
                                    </div>
                                </Section.Header>

                                <Section.Content className="text-text-secondary text-sm font-normal">
                                    Kody will analyse closed PRs and suggest
                                    rules automatically.
                                    {isGlobal &&
                                        " This is the default for every repository that doesn't set its own."}
                                </Section.Content>
                            </Section.Root>

                            <Switch
                                decorative
                                loading={isLoadingGenerateFromPastReviewsToggle}
                                checked={
                                    config?.kodyRulesGeneratorEnabled?.value
                                }
                            />
                        </div>
                    </CardHeader>
                </Card>
            </Button>

            {config?.kodyRulesGeneratorEnabled?.value && (
                <ExcludedReviewersPicker
                    teamId={teamId}
                    repositoryId={repositoryId}
                    initialExcluded={
                        config?.kodyLearningExcludedReviewers?.value ?? []
                    }
                    canEdit={canEdit}
                />
            )}
        </div>
    );
};
