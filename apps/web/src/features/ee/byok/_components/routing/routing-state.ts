import { TASK_ROUTING_FALLBACK } from "@libs/llm/llm-tasks";
import type { LLMConfigStatus } from "@services/organizationParameters/fetch";

import { formatModelLabel } from "../../_data/model-label";
import { PROVIDER_LABELS } from "../../_data/provider-labels";
import type { BYOKRouting, LlmTask } from "../../_types";
import { capabilityGate } from "./capability-gate";

/** Repeated names identify the connection without displaying URL credentials. */
export function routingModelLabels(models: LLMConfigStatus["models"]) {
    const entries = models.map((model) => ({
        ...model,
        label: formatModelLabel(model.model ?? model.modelId) || model.modelId,
    }));
    return new Map<string, string>(
        entries.map((model): [string, string] => {
            const peers = entries.filter(
                (entry) => !entry.managed && entry.label === model.label,
            );
            if (model.managed || peers.length < 2)
                return [model.modelId, model.label];
            const sameProvider = peers.filter(
                (entry) => entry.providerId === model.providerId,
            );
            const provider =
                PROVIDER_LABELS[model.providerId ?? ""] ??
                model.providerId ??
                "Connection";
            const hostOf = (url?: string) => {
                try {
                    return url ? new URL(url).host : undefined;
                } catch {
                    return undefined;
                }
            };
            const host = hostOf(model.baseUrl);
            const identity =
                sameProvider.length === 1
                    ? provider
                    : host &&
                        sameProvider.filter(
                            (entry) => hostOf(entry.baseUrl) === host,
                        ).length === 1
                      ? host
                      : `${provider} ${sameProvider.findIndex((entry) => entry.modelId === model.modelId) + 1}`;
            return [model.modelId, `${model.label} · ${identity}`];
        }),
    );
}

export const GLOBAL_ROUTING_HREF = "/settings/code-review/global/routing";
export const routingStatusQueryKey = (teamId?: string) =>
    ["llm-config-status", teamId] as const;

export function routingHref(anchor?: string | null) {
    return anchor && /^(default|fallback|task:[a-zA-Z]+)$/.test(anchor)
        ? `${GLOBAL_ROUTING_HREF}#${encodeURIComponent(anchor)}`
        : GLOBAL_ROUTING_HREF;
}

/** Env defaults are not a connected, user-configurable provider. */
export function hasRoutingProvider(status: LLMConfigStatus | null | undefined) {
    if (!status) return false;
    const models = status.models ?? [];
    return models.some(
        (model) => !model.managed && !!model.providerId && model.resolvable,
    );
}

export function normalizeRouting(routing: BYOKRouting = {}): BYOKRouting {
    return {
        mode: "manual",
        defaultModelId: routing.defaultModelId || undefined,
        fallbackModelId: routing.fallbackModelId || undefined,
        taskOverrides: Object.fromEntries(
            Object.entries(routing.taskOverrides ?? {})
                .filter(([, id]) => id && id !== routing.defaultModelId)
                .sort(([a], [b]) => a.localeCompare(b)),
        ),
    };
}

/** Only apply fields edited here; preserve another editor's other task routes. */
export function mergeRoutingEdits(
    baseline: BYOKRouting,
    draft: BYOKRouting,
    current: BYOKRouting,
): BYOKRouting {
    const next = { ...current, mode: "manual" as const };
    for (const key of ["defaultModelId", "fallbackModelId"] as const) {
        if (baseline[key] !== draft[key]) next[key] = draft[key];
    }
    const overrides = { ...current.taskOverrides };
    const tasks = new Set([
        ...Object.keys(baseline.taskOverrides ?? {}),
        ...Object.keys(draft.taskOverrides ?? {}),
    ]) as Set<LlmTask>;
    for (const task of tasks) {
        if (baseline.taskOverrides?.[task] === draft.taskOverrides?.[task])
            continue;
        const id = draft.taskOverrides?.[task];
        if (id) overrides[task] = id;
        else delete overrides[task];
    }
    return normalizeRouting({ ...next, taskOverrides: overrides });
}

/** Preview unsaved model choices with the existing task capability gate. */
export function draftTaskModel(
    task: LlmTask,
    routing: BYOKRouting,
    status: LLMConfigStatus,
    scopeModel?: string,
) {
    const parent = TASK_ROUTING_FALLBACK[task];
    const candidates = [
        scopeModel,
        routing.taskOverrides?.[task] ??
            (parent ? routing.taskOverrides?.[parent] : undefined),
        routing.defaultModelId,
        routing.fallbackModelId,
    ];
    const candidate = candidates.find((id) => {
        const model = status.models.find((entry) => entry.modelId === id);
        return (
            model &&
            !model.managed &&
            model.capabilities &&
            capabilityGate(task, model.capabilities).ok
        );
    });
    return status.models.find((model) => model.modelId === candidate)
        ?.resolvable
        ? candidate
        : undefined;
}
