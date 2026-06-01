"use client";

import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { InlineCode } from "@components/ui/inline-code";
import { Link } from "@components/ui/link";
import { magicModal } from "@components/ui/magic-modal";
import { Section } from "@components/ui/section";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import {
    generateKodyRules,
    getImportedKodyRulesCount,
    syncIDERules,
} from "@services/kodyRules/fetch";
import { useSuspenseKodyRulesCheckSyncStatus } from "@services/kodyRules/hooks";
import { PARAMETERS_PATHS } from "@services/parameters";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import {
    isCentralizedPrResponse,
    ParametersConfigKey,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useConfig } from "@providers/ConfigProvider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import { useCodeReviewConfig } from "../../../_components/context";
import { useCodeReviewRouteParams } from "../../../_hooks";
import {
    DisableIdeSyncModal,
    type DisableIdeSyncAction,
} from "./disable-ide-sync-modal";
import { GenerateFromPastReviewsFirstTimeModal } from "./generate-from-past-reviews-modal";
import { SyncFromIDEFilesFirstTimeModal } from "./sync-from-ide-files-modal";

export const GenerateRulesOptions = () => {
    const cfg = useConfig();
    const config = useCodeReviewConfig();
    const { teamId } = useSelectedTeamId();
    const { repositoryId } = useCodeReviewRouteParams();
    const { invalidateQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();
    const syncStatus = useSuspenseKodyRulesCheckSyncStatus({
        teamId,
        repositoryId,
    });
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
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

            if (syncStatus.kodyRulesGeneratorEnabledFirstTime && newValue) {
                const response = await magicModal.show(() => (
                    <GenerateFromPastReviewsFirstTimeModal />
                ));

                if (response) {
                    generateKodyRules(teamId);

                    invalidateQueries({
                        queryKey: generateQueryKey(
                            PARAMETERS_PATHS.GET_BY_KEY,
                            {
                                params: {
                                    teamId,
                                    key: ParametersConfigKey.PLATFORM_CONFIGS,
                                },
                            },
                        ),
                    });
                }
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

    const [handleIDESyncToggle, { loading: isLoadingIDESyncToggle }] =
        useAsyncAction(async () => {
            try {
                const newValue = !config?.ideRulesSyncEnabled?.value;

                // When turning the toggle OFF, ask the user what should happen
                // to the rules already imported from IDE files for this repo.
                // If there are none active, fall through with the safe default
                // ("keep") and don't bother showing the modal.
                let ideSyncDisableAction: DisableIdeSyncAction = "keep";
                if (newValue === false && repositoryId) {
                    const counts = await getImportedKodyRulesCount({
                        repositoryId,
                    });

                    if (counts.active > 0) {
                        const picked = await magicModal.show(() => (
                            <DisableIdeSyncModal counts={counts} />
                        ));
                        if (!picked) {
                            // User cancelled — do not flip the toggle.
                            return;
                        }
                        ideSyncDisableAction =
                            picked as DisableIdeSyncAction;
                    }
                }

                const mutationResult = await createOrUpdateCodeReviewParameter(
                    {
                        ideRulesSyncEnabled: newValue,
                        ...(newValue === false && {
                            ideSyncDisableAction,
                        }),
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
                    queryKey: generateQueryKey(
                        KODY_RULES_PATHS.CHECK_SYNC_STATUS,
                        { params: { teamId, repositoryId } },
                    ),
                });

                invalidateQueries({
                    queryKey: generateQueryKey(
                        PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
                        {
                            params: { teamId },
                        },
                    ),
                });

                // Toggle off → backend may have flipped imported rules to
                // DELETED or PAUSED. The Kody Rules tab caches its rule
                // list separately, so without these invalidations the
                // user sees stale rows until they manually refresh.
                invalidateQueries({
                    queryKey: generateQueryKey(
                        KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER,
                        { params: { repositoryId } },
                    ),
                });
                invalidateQueries({
                    queryKey: generateQueryKey(
                        KODY_RULES_PATHS.GET_INHERITED_RULES,
                        { params: { teamId, repositoryId } },
                    ),
                });
                invalidateQueries({
                    queryKey: generateQueryKey(
                        KODY_RULES_PATHS.COUNT_IMPORTED_KODY_RULES,
                        { params: { repositoryId } },
                    ),
                });

                toast({ description: "Settings saved", variant: "success" });

                if (syncStatus.ideRulesSyncEnabledFirstTime && newValue) {
                    const response = await magicModal.show(() => (
                        <SyncFromIDEFilesFirstTimeModal />
                    ));

                    if (response) syncIDERules({ teamId, repositoryId });
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

    const enabledCount = [
        config?.kodyRulesGeneratorEnabled?.value,
        config?.ideRulesSyncEnabled?.value,
    ].filter(Boolean).length;

    return (
        <div className="flex flex-col gap-2">
            <Button
                size="lg"
                variant="helper"
                className="w-full justify-between p-0"
                disabled={!canEdit}
                onClick={() => handleIDESyncToggle()}>
                <Card color="none" className="w-full">
                    <CardHeader>
                        <div className="flex items-center justify-between gap-20">
                            <Section.Root>
                                <Section.Header>
                                    <Section.Title>
                                        Auto-sync rules from repo
                                    </Section.Title>
                                </Section.Header>

                                <Section.Content>
                                    <Section.Description>
                                        When enabled, Kody will automatically
                                        import rule files{" "}
                                        <InlineCode className="bg-card-lv1">
                                            (.cursorrules, CLAUDE.md, etc...)
                                        </InlineCode>{" "}
                                        found in this repository and keep them
                                        in sync.
                                    </Section.Description>
                                </Section.Content>
                            </Section.Root>

                            <Switch
                                decorative
                                loading={isLoadingIDESyncToggle}
                                checked={config?.ideRulesSyncEnabled?.value}
                            />
                        </div>
                    </CardHeader>
                </Card>
            </Button>

            <span className="text-text-secondary -mt-1 mb-2 ml-2 text-xs">
                <span>
                    For a detailed list of rule files that can be scanned,{" "}
                </span>
                <Link href={cfg.ruleFilesDocs || ""}>check the docs</Link>
                .
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
                                    <Section.Title>
                                        Generate from past reviews
                                    </Section.Title>
                                </Section.Header>

                                <Section.Content className="text-text-secondary text-sm font-normal">
                                    Kody will analyse closed PRs and suggest
                                    rules automatically.
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
        </div>
    );
};
