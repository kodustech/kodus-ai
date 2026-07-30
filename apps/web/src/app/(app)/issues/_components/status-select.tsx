"use client";

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
} from "@components/ui/select";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { changeIssueParameter } from "@services/issues/fetch";
import type {
    IssueItem,
    IssueListItem,
    IssueStatus,
} from "@services/issues/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "src/core/utils/components";
import { apiProxyPath } from "src/core/utils/api-proxy";
import { generateQueryKey } from "src/core/utils/reactQuery";

import { issueStatusClassnames } from "./status-badge";

const STATUS_OPTIONS = [
    "open",
    "dismissed",
    "resolved",
] satisfies Array<IssueStatus>;

export const StatusSelect = ({
    issueId,
    status,
    repoId,
}: {
    issueId: string;
    status: IssueStatus;
    repoId: string;
}) => {
    const queryClient = useQueryClient();
    const canEdit = usePermission(Action.Update, ResourceType.Issues, repoId);

    const [changeIssueParameterAction, { loading }] = useAsyncAction(
        async (status: IssueStatus) => {
            try {
                await changeIssueParameter({
                    id: issueId,
                    field: "status",
                    value: status,
                });

                queryClient.setQueryData<IssueItem>(
                    generateQueryKey(apiProxyPath(`/issues/${issueId}`)),
                    (old) => (!old ? old : { ...old, status }),
                );

                queryClient.setQueriesData<IssueListItem[]>(
                    {
                        exact: false,
                        queryKey: generateQueryKey(apiProxyPath("/issues")),
                    },
                    (old = []) =>
                        old.map((d) =>
                            d.uuid === issueId ? { ...d, status } : d,
                        ),
                );

                queryClient.invalidateQueries({
                    queryKey: generateQueryKey(
                        apiProxyPath("/issues/count"),
                    ),
                });
            } catch {
                toast({
                    variant: "warning",
                    title: "Failed to change status",
                });
            }
        },
    );

    return (
        <Select
            value={status}
            disabled={!canEdit || loading}
            onValueChange={(v) => changeIssueParameterAction(v as IssueStatus)}>
            <SelectTrigger
                size="xs"
                loading={loading}
                className={cn(
                    "w-fit gap-4 capitalize",
                    issueStatusClassnames[status],
                )}>
                {status}
            </SelectTrigger>

            <SelectContent align="end" className="w-36">
                {STATUS_OPTIONS.map((s) => (
                    <SelectItem
                        key={s}
                        value={s}
                        className="min-h-auto gap-1.5 px-4 py-2 capitalize [--icon-size:calc(var(--spacing)*4)]">
                        {s}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
};
