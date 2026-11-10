"use client";

import { useState } from "react";
import { toast } from "@components/ui/toaster/use-toast";
import {
    createOrUpdateOrganizationParameter,
    getBYOK,
    type LLMConfigStatus,
} from "@services/organizationParameters/fetch";
import { OrganizationParametersConfigKey } from "@services/parameters/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";
import { buildByokBlob } from "src/features/ee/byok/_components/byok-write";
import {
    draftTaskModel,
    mergeRoutingEdits,
    normalizeRouting,
    routingModelLabels,
    RoutingSettingsError,
    sameRouting,
} from "src/features/ee/byok/_components/routing/routing-state";
import type { PoolModel } from "src/features/ee/byok/_components/routing/task-override-grid";
import { formatModelLabel } from "src/features/ee/byok/_data/model-label";
import type { BYOKRouting, LlmTask } from "src/features/ee/byok/_types";
import {
    groupModelsByProvider,
    hasVisibleModels,
} from "src/features/ee/byok/_utils";

type Edit = { baseline: BYOKRouting; routing: BYOKRouting };

export function useOrganizationRouting({
    teamId,
    enabled,
    canEdit,
    status,
}: {
    teamId?: string;
    enabled: boolean;
    canEdit: boolean;
    status: LLMConfigStatus | null;
}) {
    const queryClient = useQueryClient();
    const queryKey = ["organization-routing", teamId, enabled] as const;
    const query = useQuery({
        queryKey,
        queryFn: async () => (await getBYOK()) ?? null,
        enabled,
        staleTime: 0,
        refetchOnWindowFocus: true,
        retry: 1,
        throwOnError: false,
    });
    const [edit, setEdit] = useState<Edit | null>(null);
    const saved = normalizeRouting(query.data?.routing);
    const routing = edit?.routing ?? saved;
    const dirty = !!edit && !sameRouting(edit.baseline, routing);
    const labels = routingModelLabels(status?.models ?? []);
    const pool: PoolModel[] = groupModelsByProvider(
        enabled ? query.data : undefined,
    ).flatMap((group) =>
        group.models.map((model) => {
            const metadata = status?.models.find(
                (entry) => entry.modelId === model.id,
            );
            return {
                id: model.id,
                label:
                    (labels.get(model.id) ?? formatModelLabel(model.model)) ||
                    model.id,
                provider: group.credential.provider,
                capabilities: metadata?.capabilities,
                disabled: !metadata?.resolvable,
                disabledReason: !metadata?.resolvable
                    ? "Reconnect this provider before using its model."
                    : undefined,
            };
        }),
    );
    const setRouting = (update: (current: BYOKRouting) => BYOKRouting) => {
        if (!canEdit || !query.data) return;
        setEdit((current) => {
            const baseline = current?.baseline ?? saved;
            const next = normalizeRouting(update(current?.routing ?? saved));
            return sameRouting(next, baseline)
                ? null
                : { baseline, routing: next };
        });
    };
    const setTask = (task: LlmTask, id?: string) =>
        setRouting((current) => {
            const overrides = { ...current.taskOverrides };
            if (id) overrides[task] = id;
            else delete overrides[task];
            return { ...current, taskOverrides: overrides };
        });
    const setDefault = (id: string) =>
        setRouting((current) => ({
            ...current,
            defaultModelId: id,
            fallbackModelId:
                current.fallbackModelId === id
                    ? undefined
                    : current.fallbackModelId,
        }));
    const validationError =
        dirty &&
        !pool.some(
            (model) => model.id === routing.defaultModelId && !model.disabled,
        )
            ? "Select a connected default model."
            : undefined;

    useUnsavedChangesGuard({
        id: `organization-routing-${teamId}`,
        isDirty: dirty,
        onBlock: () =>
            toast({
                variant: "warning",
                title: "Unsaved routing changes",
                description: "Save or reset your changes before leaving.",
            }),
    });

    const save = async (currentStatus: LLMConfigStatus | null = status) => {
        if (!dirty || !edit) return false;
        if (!canEdit)
            throw new RoutingSettingsError(
                "You cannot edit organization models.",
            );
        if (validationError) throw new RoutingSettingsError(validationError);
        // Re-read: a model added or credential rotated in another tab must survive.
        const fresh = await getBYOK();
        queryClient.setQueryData(queryKey, fresh ?? null);
        if (!fresh || !hasVisibleModels(fresh))
            throw new RoutingSettingsError(
                "Connect an AI provider before changing routing.",
            );
        const next = mergeRoutingEdits(
            edit.baseline,
            edit.routing,
            fresh.routing ?? {},
        );
        const changedIds = [
            ...(edit.baseline.defaultModelId !== edit.routing.defaultModelId
                ? [edit.routing.defaultModelId]
                : []),
            ...(edit.baseline.fallbackModelId !== edit.routing.fallbackModelId
                ? [edit.routing.fallbackModelId]
                : []),
            ...Object.entries(edit.routing.taskOverrides ?? {})
                .filter(
                    ([task, id]) =>
                        edit.baseline.taskOverrides?.[task as LlmTask] !== id,
                )
                .map(([, id]) => id),
        ].filter(Boolean);
        if (
            changedIds.some(
                (id) => !fresh.models.some((model) => model.id === id),
            )
        )
            throw new RoutingSettingsError(
                "A selected model was removed. Refresh and choose a connected model.",
            );
        if (
            changedIds.some(
                (id) =>
                    !currentStatus?.models.some(
                        (model) =>
                            model.modelId === id &&
                            model.resolvable &&
                            !model.managed,
                    ),
            )
        )
            throw new RoutingSettingsError(
                "A selected provider is unavailable. Reconnect it or choose another model.",
            );
        await createOrUpdateOrganizationParameter(
            OrganizationParametersConfigKey.BYOK_CONFIG,
            buildByokBlob(fresh, { kind: "routing", routing: next }),
        );
        queryClient.setQueryData(queryKey, { ...fresh, routing: next });
        setEdit(null);
        return true;
    };

    return {
        effectiveModel: (
            task: "riskAssessment" | "codeReview" | "codeReviewHeavy",
        ) => {
            const modelId = status
                ? dirty
                    ? draftTaskModel(task, routing, status)
                    : task === "riskAssessment"
                      ? status.modelRouting?.riskAssessment.modelId
                      : status.reviewModels?.[
                            task === "codeReviewHeavy" ? "heavy" : "balanced"
                        ].modelId
                : undefined;
            return {
                modelId,
                label:
                    pool.find((model) => model.id === modelId)?.label ??
                    (status?.env.model
                        ? formatModelLabel(status.env.model)
                        : "Kodus default"),
            };
        },
        routing,
        pool,
        dirty,
        validationError,
        loading: enabled && query.isPending,
        error: enabled && (query.isError || (query.isSuccess && !query.data)),
        ready: enabled && !!query.data,
        refetch: query.refetch,
        canEdit: canEdit && !!query.data && !query.isFetching,
        setDefault,
        setTask,
        setFallback: (id?: string) =>
            setRouting((current) => ({ ...current, fallbackModelId: id })),
        reset: () => setEdit(null),
        save,
    };
}

export type OrganizationRoutingController = ReturnType<
    typeof useOrganizationRouting
>;
