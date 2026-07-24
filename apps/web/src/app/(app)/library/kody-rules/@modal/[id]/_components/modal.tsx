"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { Section } from "@components/ui/section";
import { Separator } from "@components/ui/separator";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import { addKodyRuleToRepositories } from "@services/kodyRules/fetch";
import {
    KodyRulesOrigin,
    KodyRulesStatus,
    resolveKodyRuleDisplaySeverity,
    type KodyRule,
    type LibraryRule,
} from "@services/kodyRules/types";
import { isCentralizedPrResponse } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import {
    removeRuleFeedback,
    sendRuleFeedback,
    type FeedbackType,
} from "@services/ruleFeedback/fetch";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, ThumbsDown, ThumbsUp } from "lucide-react";
import type { CodeReviewRepositoryConfig } from "src/app/(app)/settings/code-review/_types";
import { getCentralizedPrToastPayload } from "src/app/(app)/settings/code-review/_utils/centralized-pr-feedback";
import { useAuth } from "src/core/providers/auth.provider";
import { usePermissions } from "src/core/providers/permissions.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import type { LiteralUnion } from "src/core/types";
import { cn } from "src/core/utils/components";
import { hasPermission } from "src/core/utils/permission-map";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { SelectRepositoriesDropdown } from "./dropdown";
import { ExampleSection } from "./examples";

export const KodyRuleLibraryItemModal = ({
    rule,
    repositoryId,
    directoryId,
    repositories,
}: {
    rule: LibraryRule;
    repositoryId: LiteralUnion<"global"> | undefined;
    directoryId: string | undefined;
    repositories: Array<CodeReviewRepositoryConfig>;
}) => {
    const router = useRouter();
    const { teamId } = useSelectedTeamId();
    const { organizationId } = useAuth();
    const queryClient = useQueryClient();
    const [positiveCount, setPositiveCount] = useState(rule.positiveCount ?? 0);
    const [negativeCount, setNegativeCount] = useState(rule.negativeCount ?? 0);
    const [userFeedback, setUserFeedback] = useState<FeedbackType | null>(
        rule.userFeedback as FeedbackType | null,
    );

    const permissions = usePermissions();
    const allowedRepositories = repositories.filter((repository) =>
        hasPermission({
            permissions,
            action: Action.Create,
            resource: ResourceType.KodyRules,
            repoId: repository.id,
            organizationId: organizationId!,
        }),
    );

    const canGlobal = usePermission(
        Action.Create,
        ResourceType.KodyRules,
        "global",
    );
    const canEdit = usePermission(
        Action.Update,
        ResourceType.KodyRules,
        repositoryId,
    );

    const [selectedRepositoriesIds, setSelectedRepositoriesIds] = useState<
        string[]
    >(repositoryId && !directoryId ? [repositoryId] : []);

    const [selectedDirectoriesIds, setSelectedDirectoriesIds] = useState<
        Array<{ directoryId: string; repositoryId: string }>
    >(repositoryId && directoryId ? [{ repositoryId, directoryId }] : []);

    const [addToRepositories, { loading: isAddingToRepositories }] =
        useAsyncAction(async () => {
            const newRule: KodyRule = {
                title: rule.title,
                rule: rule.rule,
                severity: resolveKodyRuleDisplaySeverity(
                    rule,
                ) as KodyRule["severity"],
                path: "",
                examples: rule.examples,
                origin: KodyRulesOrigin.LIBRARY,
                status: KodyRulesStatus.ACTIVE,
                scope: "file",
            };

            if (directoryId) {
                const repository = repositories.find(
                    (r) => r.id === repositoryId,
                );
                const directory = repository?.directories?.find(
                    (d) => d.id === directoryId,
                );
                newRule.path = `${(directory?.folders?.[0]?.path ?? '').slice(1)}/**`;
            }

            // Global already applies to every repository through inheritance,
            // so if it comes selected alongside specific repos we import into
            // Global only — otherwise the rule is duplicated in each repo (one
            // inherited-from-global copy plus a directly-added copy).
            const importsGlobally = selectedRepositoriesIds.includes("global");
            const repositoriesIds = importsGlobally
                ? ["global"]
                : selectedRepositoriesIds;
            const directoriesIds = importsGlobally ? [] : selectedDirectoriesIds;

            const addedKodyRules = await addKodyRuleToRepositories({
                rule: newRule,
                repositoriesIds,
                directoriesIds,
                teamId,
            });

            if (isCentralizedPrResponse(addedKodyRules)) {
                toast(
                    getCentralizedPrToastPayload(
                        addedKodyRules,
                        `Rule "${rule.title}" change proposed through centralized pull request.`,
                    ),
                );

                return;
            }

            await queryClient.resetQueries({
                predicate: (query) =>
                    query.queryKey[0] ===
                    KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER,
            });

            toast({
                variant: "success",
                title: `Rule "${rule.title}" added to selected repositories`,
                description: (
                    <ul className="list-disc pl-4">
                        {addedKodyRules.map((rule) => {
                            const repository = repositories.find(
                                (r) => r.id === rule.repositoryId,
                            );

                            const directory = repository?.directories?.find(
                                (d) => d.id === rule.directoryId,
                            );

                            const directoryFullPath = directory?.folders?.[0]?.path
                                ? `${repository?.name}${directory.folders[0].path}`
                                : undefined;

                            return (
                                <li key={rule.uuid}>
                                    {rule.repositoryId === "global"
                                        ? "Global"
                                        : (directoryFullPath ??
                                          repository?.name)}
                                </li>
                            );
                        })}
                    </ul>
                ),
            });

            if (repositoryId) {
                return router.push(
                    addSearchParamsToUrl(
                        `/settings/code-review/${repositoryId}/kody-rules`,
                        { directoryId },
                    ),
                );
            }

            return router.push(`/library/kody-rules`);
        });

    const badExample = rule.examples?.find(({ isCorrect }) => !isCorrect);
    const goodExample = rule.examples?.find(({ isCorrect }) => isCorrect);

    const { mutate: sendFeedback, isPending: isFeedbackActionInProgress } =
        useMutation<any, Error, FeedbackType>({
            mutationFn: async (feedback: FeedbackType) => {
                const isRemovingFeedback = userFeedback === feedback;

                if (isRemovingFeedback) {
                    return removeRuleFeedback(rule.uuid);
                } else {
                    return sendRuleFeedback(rule.uuid, feedback);
                }
            },
            onSuccess: (data, feedback) => {
                revalidateServerSidePath("/library/kody-rules");
                const isRemovingFeedback = userFeedback === feedback;
                const newFeedback = isRemovingFeedback ? null : feedback;

                if (feedback === "positive") {
                    if (isRemovingFeedback) {
                        setPositiveCount((prev) => prev - 1);
                    } else {
                        setPositiveCount((prev) => prev + 1);
                        if (userFeedback === "negative") {
                            setNegativeCount((prev) => prev - 1);
                        }
                    }
                } else {
                    if (isRemovingFeedback) {
                        setNegativeCount((prev) => prev - 1);
                    } else {
                        setNegativeCount((prev) => prev + 1);
                        if (userFeedback === "positive") {
                            setPositiveCount((prev) => prev - 1);
                        }
                    }
                }

                setUserFeedback(newFeedback);
            },
            onError: (error) => {
                console.error("Error sending feedback:", error);
            },
        });

    return (
        <Dialog
            open
            onOpenChange={() => {
                if (window.history.length === 1) {
                    router.push("/library/kody-rules");
                } else {
                    router.back();
                }
            }}>
            <DialogContent className="max-w-3xl">
                <DialogHeader className="flex-row justify-between gap-3">
                    <DialogTitle className="flex flex-wrap items-center gap-2">
                        {rule.title}

                        <IssueSeverityLevelBadge
                            severity={resolveKodyRuleDisplaySeverity(rule)}
                        />
                    </DialogTitle>

                    <div className="flex items-center gap-1">
                        <Button
                            size="md"
                            variant="cancel"
                            onClick={() => sendFeedback("positive")}
                            disabled={isFeedbackActionInProgress}
                            className={cn(
                                "-my-2 gap-1.5 px-2 transition-colors",
                                userFeedback === "positive" &&
                                    "border-green-500/20 bg-green-500/10 text-green-500",
                            )}
                            rightIcon={
                                isFeedbackActionInProgress ? (
                                    <Spinner className="size-2.5" />
                                ) : (
                                    <ThumbsUp className="size-3" />
                                )
                            }>
                            {positiveCount > 0 ? positiveCount : null}
                        </Button>

                        <Button
                            size="md"
                            variant="cancel"
                            onClick={() => sendFeedback("negative")}
                            disabled={isFeedbackActionInProgress}
                            className={cn(
                                "-my-2 gap-1.5 px-2 transition-colors",
                                userFeedback === "negative" &&
                                    "border-red-500/20 bg-red-500/10 text-red-500",
                            )}
                            rightIcon={
                                isFeedbackActionInProgress ? (
                                    <Spinner className="size-2.5" />
                                ) : (
                                    <ThumbsDown className="size-3" />
                                )
                            }>
                            {negativeCount > 0 ? negativeCount : null}
                        </Button>
                    </div>
                </DialogHeader>

                <div className="-mx-6 overflow-auto px-6">
                    <div className="flex flex-col gap-6">
                        <Section.Root>
                            <Section.Header>
                                <Section.Title>
                                    Why is it important?
                                </Section.Title>
                            </Section.Header>

                            <Section.Content className="text-text-secondary text-sm">
                                {rule.why_is_this_important}
                            </Section.Content>
                        </Section.Root>

                        <Section.Root>
                            <Section.Header>
                                <Section.Title>Instructions</Section.Title>
                            </Section.Header>

                            <Section.Content className="text-text-secondary text-sm">
                                {rule.rule}
                            </Section.Content>
                        </Section.Root>

                        <Separator />

                        {badExample && (
                            <ExampleSection
                                language={rule.language}
                                example={badExample}
                            />
                        )}

                        {goodExample && (
                            <ExampleSection
                                language={rule.language}
                                example={goodExample}
                            />
                        )}
                    </div>
                </div>

                <DialogFooter className="justify-between gap-8">
                    <div className="flex shrink-0 flex-row items-center justify-end gap-px">
                        {repositoryId ? (
                            // Adding is never blocked — a rule beyond the
                            // free plan's active-rule cap is still created,
                            // just PAUSED + locked in the destination list
                            // (mirrors MCP plugins beyond their cap).
                            <Button
                                size="md"
                                variant="primary"
                                leftIcon={<Plus />}
                                onClick={addToRepositories}
                                disabled={!canEdit}
                                loading={isAddingToRepositories}>
                                Add to my rules
                            </Button>
                        ) : (
                            <>
                                <Button
                                    size="md"
                                    variant="primary"
                                    leftIcon={<Plus />}
                                    className="rounded-r-none"
                                    onClick={addToRepositories}
                                    loading={isAddingToRepositories}
                                    disabled={
                                        !canEdit ||
                                        (selectedRepositoriesIds.length ===
                                            0 &&
                                            selectedDirectoriesIds.length ===
                                                0)
                                    }>
                                    Add to my rules
                                </Button>

                                <SelectRepositoriesDropdown
                                    repositories={allowedRepositories}
                                    selectedRepositoriesIds={
                                        selectedRepositoriesIds
                                    }
                                    selectedDirectoriesIds={
                                        selectedDirectoriesIds
                                    }
                                    setSelectedRepositoriesIds={
                                        setSelectedRepositoriesIds
                                    }
                                    setSelectedDirectoriesIds={
                                        setSelectedDirectoriesIds
                                    }
                                    canEdit={canEdit}
                                    global={canGlobal}
                                />
                            </>
                        )}
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
