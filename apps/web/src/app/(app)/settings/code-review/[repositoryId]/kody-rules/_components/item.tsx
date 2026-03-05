"use client";

import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Link } from "@components/ui/link";
import { magicModal } from "@components/ui/magic-modal";
import { Section } from "@components/ui/section";
import { Separator } from "@components/ui/separator";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    KodyRulesType,
    type KodyRuleWithInheritanceDetails,
} from "@services/kodyRules/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { EditIcon, EyeIcon, TrashIcon } from "lucide-react";
import { SuggestionsModal } from "src/app/(app)/library/kody-rules/_components/suggestions-modal";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { DeleteKodyRuleConfirmationModal } from "../../../_components/delete-confirmation-modal";
import { useCodeReviewRouteParams } from "../../../../_hooks";
import { ExternalReferencesDisplay } from "../../pr-summary/_components/external-references-display";

export const KodyRuleItem = ({
    rule,
    tab,
    onAnyChange,
    showSuggestionsButton = false,
}: {
    rule: KodyRuleWithInheritanceDetails;
    tab: "review-rules" | "memories";
    onAnyChange: () => void;
    showSuggestionsButton?: boolean;
}) => {
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { teamId } = useSelectedTeamId();
    const canEdit = usePermission(
        Action.Update,
        ResourceType.KodyRules,
        repositoryId,
    );
    const canDelete = usePermission(
        Action.Delete,
        ResourceType.KodyRules,
        repositoryId,
    );

    const isInherited = !!rule.inherited;
    const isExcluded = isInherited && !!rule.excluded;
    const isMemory =
        (rule.type ?? KodyRulesType.STANDARD) === KodyRulesType.MEMORY;
    const entityLabel = isMemory ? "memory" : "rule";

    return (
        <Card>
            <CardHeader className="flex-row items-start justify-between gap-10">
                <div className="-mb-2 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        {!isMemory && (
                            <IssueSeverityLevelBadge severity={rule.severity} />
                        )}

                        {rule.sourcePath && (
                            <Badge
                                active
                                size="xs"
                                className="min-h-auto px-2.5 py-1">
                                auto-sync
                            </Badge>
                        )}

                        {isInherited && (
                            <Tooltip delayDuration={500}>
                                <TooltipTrigger>
                                    <Badge
                                        active
                                        size="xs"
                                        className="bg-muted/10 text-muted ring-muted/64 pointer-events-none h-6 min-h-auto rounded-lg px-2 text-[10px] leading-px uppercase ring-1 [--button-foreground:var(--color-muted)]">
                                        Inherited: {rule.inherited}
                                    </Badge>
                                </TooltipTrigger>

                                <TooltipContent>
                                    <p>
                                        This {entityLabel} is inherited and
                                        cannot be edited or deleted here.
                                    </p>
                                    <p>
                                        Click the eye icon to view its details
                                        or to disable it for this scope.
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        )}

                        {isExcluded && (
                            <Tooltip delayDuration={500}>
                                <TooltipTrigger>
                                    <Badge
                                        active
                                        size="xs"
                                        className="bg-muted/10 text-muted ring-muted/64 pointer-events-none h-6 min-h-auto rounded-lg px-2 text-[10px] leading-px uppercase ring-1 [--button-foreground:var(--color-muted)]">
                                        Disabled
                                    </Badge>
                                </TooltipTrigger>

                                <TooltipContent>
                                    <p>
                                        This {entityLabel} is inherited but
                                        disabled for this scope.
                                    </p>
                                    <p>
                                        Click the eye icon to view its details
                                        or to enable it for this scope.
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        )}
                    </div>

                    <Heading variant="h3" className="text-base">
                        {rule.title}
                    </Heading>
                </div>

                <div className="flex items-center gap-2">
                    {showSuggestionsButton && rule.uuid && (
                        <SuggestionsModal
                            ruleId={rule.uuid}
                            ruleTitle={rule.title}
                            variant="icon"
                        />
                    )}

                    <Link
                        href={addSearchParamsToUrl(
                            `/settings/code-review/${repositoryId}/kody-rules/${rule.uuid}`,
                            { directoryId, teamId, tab },
                        )}>
                        <Button
                            decorative
                            size="icon-md"
                            variant="secondary"
                            className="size-9">
                            {!canEdit || isInherited ? (
                                <EyeIcon />
                            ) : (
                                <EditIcon />
                            )}
                        </Button>
                    </Link>

                    <Button
                        size="icon-md"
                        variant="secondary"
                        className="size-9 [--button-foreground:var(--color-danger)]"
                        disabled={!canDelete || isInherited}
                        onClick={() => {
                            magicModal.show(() => (
                                <DeleteKodyRuleConfirmationModal
                                    rule={rule}
                                    onSuccess={() => onAnyChange?.()}
                                />
                            ));
                        }}>
                        <TrashIcon />
                    </Button>
                </div>
            </CardHeader>

            <CardContent className="flex flex-col gap-3">
                <Card
                    color="lv1"
                    className="text-text-secondary -mx-6 -mb-6 flex-1 rounded-t-none text-sm">
                    <CardHeader>
                        <div className="flex flex-row">
                            <Section.Root className="flex-1">
                                <Section.Header>
                                    <Section.Title>
                                        {isMemory ? "Applies to:" : "Path:"}
                                    </Section.Title>
                                </Section.Header>

                                <Section.Content>
                                    {isMemory
                                        ? "All prompts and conversations"
                                        : rule.path || "all files (default)"}
                                </Section.Content>
                            </Section.Root>

                            {rule.sourcePath && (
                                <>
                                    <Separator
                                        orientation="vertical"
                                        className="bg-card-lv2 mx-4"
                                    />

                                    <Section.Root className="flex-1">
                                        <Section.Header>
                                            <Section.Title>
                                                Source:
                                            </Section.Title>
                                        </Section.Header>

                                        <Section.Content>
                                            {rule.sourcePath}
                                        </Section.Content>
                                    </Section.Root>
                                </>
                            )}

                            {!isMemory && (
                                <>
                                    <Separator
                                        orientation="vertical"
                                        className="bg-card-lv2 mx-4"
                                    />

                                    <Section.Root className="flex-1 shrink">
                                        <Section.Header>
                                            <Section.Title>
                                                Scope:
                                            </Section.Title>
                                        </Section.Header>

                                        <Section.Content>
                                            {rule.scope === "pull-request"
                                                ? "Pull-request"
                                                : "File"}
                                        </Section.Content>
                                    </Section.Root>
                                </>
                            )}
                        </div>

                        <Separator className="bg-card-lv2 my-3" />

                        <Section.Root>
                            <Section.Header>
                                <Section.Title>Instructions:</Section.Title>
                            </Section.Header>

                            <Section.Content className="line-clamp-3">
                                {rule.rule}
                            </Section.Content>

                            <ExternalReferencesDisplay
                                externalReferences={{
                                    references: rule.externalReferences || [],
                                    syncErrors: rule.syncErrors || [],
                                    processingStatus:
                                        rule.referenceProcessingStatus ||
                                        "completed",
                                }}
                                compact
                            />
                        </Section.Root>
                    </CardHeader>
                </Card>
            </CardContent>
        </Card>
    );
};
