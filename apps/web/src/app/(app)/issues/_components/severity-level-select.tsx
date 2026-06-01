"use client";

import {
    IssueSeverityLevelBadge,
    severityLevelClassnames,
} from "@components/system/issue-severity-level-badge";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
} from "@components/ui/select";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { changeIssueParameter } from "@services/issues/fetch";
import type { IssueItem, IssueListItem } from "@services/issues/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useQueryClient } from "@tanstack/react-query";
import { SeverityLevel } from "src/core/types";
import { cn } from "src/core/utils/components";
import { apiProxyPath } from "src/core/utils/api-proxy";
import { generateQueryKey } from "src/core/utils/reactQuery";

const SEVERITY_OPTIONS = [
    SeverityLevel.LOW,
    SeverityLevel.MEDIUM,
    SeverityLevel.HIGH,
    SeverityLevel.CRITICAL,
] satisfies Array<SeverityLevel>;

export const SeverityLevelSelect = ({
    issueId,
    severity,
    repoId,
}: {
    issueId: string;
    severity: SeverityLevel;
    repoId: string;
}) => {
    const queryClient = useQueryClient();
    const canEdit = usePermission(Action.Update, ResourceType.Issues, repoId);

    const [changeIssueParameterAction, { loading }] = useAsyncAction(
        async (severity: SeverityLevel) => {
            try {
                await changeIssueParameter({
                    id: issueId,
                    field: "severity",
                    value: severity,
                });

                queryClient.setQueryData<IssueItem>(
                    generateQueryKey(apiProxyPath(`/issues/${issueId}`)),
                    (old) => (!old ? old : { ...old, severity }),
                );

                queryClient.setQueriesData<IssueListItem[]>(
                    {
                        exact: false,
                        queryKey: generateQueryKey(apiProxyPath("/issues")),
                    },
                    (old = []) =>
                        old.map((d) =>
                            d.uuid === issueId ? { ...d, severity } : d,
                        ),
                );
            } catch {
                toast({
                    variant: "warning",
                    title: "Failed to change severity level",
                });
            }
        },
    );

    return (
        <Select
            value={severity}
            disabled={!canEdit || loading}
            onValueChange={(v) =>
                changeIssueParameterAction(v as SeverityLevel)
            }>
            <SelectTrigger
                loading={loading}
                className={cn(
                    "min-h-auto w-fit gap-1 rounded-lg py-1 pr-3.5 pl-2 text-xs leading-none uppercase [--icon-size:calc(var(--spacing)*4)]",
                    severityLevelClassnames[severity],
                )}>
                {severity}
            </SelectTrigger>

            <SelectContent>
                {SEVERITY_OPTIONS.map((s) => (
                    <SelectItem
                        key={s}
                        value={s}
                        className="min-h-auto gap-1.5 py-1 pr-4 pl-1 [--icon-size:calc(var(--spacing)*4)]">
                        <IssueSeverityLevelBadge severity={s} />
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
};
