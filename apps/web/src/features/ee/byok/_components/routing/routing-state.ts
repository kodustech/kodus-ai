import { TASK_ROUTING_FALLBACK } from "@libs/llm/llm-tasks";
import type { LLMConfigStatus } from "@services/organizationParameters/fetch";

import { formatModelLabel } from "../../_data/model-label";
import { PROVIDER_LABELS } from "../../_data/provider-labels";
import type { BYOKRouting, LlmTask } from "../../_types";
import { capabilityGate } from "./capability-gate";

/** Repeated names identify the connection without displaying URL credentials. */
export function routingModelLabels(models: LLMConfigStatus["models"]) {
    const hostOf = (url?: string) => {
        try {
            return url ? new URL(url).host : undefined;
        } catch {
            return undefined;
        }
    };
    const groups = new Map<
        string,
        Map<string | undefined, { count: number; hosts: Map<string, number> }>
    >();
    const entries = models.map((model) => ({
        ...model,
        label: formatModelLabel(model.model ?? model.modelId) || model.modelId,
        host: hostOf(model.baseUrl),
    }));
    const labelCounts = new Map<string, number>();
    const ordinals = new Map<string, number>();
    for (const model of entries) {
        if (model.managed) continue;
        labelCounts.set(model.label, (labelCounts.get(model.label) ?? 0) + 1);
        let providers = groups.get(model.label);
        if (!providers) groups.set(model.label, (providers = new Map()));
        let group = providers.get(model.providerId);
        if (!group)
            providers.set(
                model.providerId,
                (group = { count: 0, hosts: new Map() }),
            );
        ordinals.set(model.modelId, ++group.count);
        if (model.host)
            group.hosts.set(model.host, (group.hosts.get(model.host) ?? 0) + 1);
    }
    return new Map<string, string>(
        entries.map((model): [string, string] => {
            if (model.managed || (labelCounts.get(model.label) ?? 0) < 2)
                return [model.modelId, model.label];
            const group = groups.get(model.label)!.get(model.providerId)!;
            const provider =
                PROVIDER_LABELS[model.providerId ?? ""] ??
                model.providerId ??
                "Connection";
            const identity =
                group.count === 1
                    ? provider
                    : model.host && group.hosts.get(model.host) === 1
                      ? model.host
                      : `${provider} ${ordinals.get(model.modelId)}`;
            return [model.modelId, `${model.label} · ${identity}`];
        }),
    );
}

/** Exact slot IDs win. Legacy names resolve only when they identify one slot. */
export function indexRoutingModels(models: LLMConfigStatus["models"]) {
    const byId = new Map(models.map((model) => [model.modelId, model]));
    const byName = new Map<string, (typeof models)[number] | null>();
    for (const model of models) {
        if (model.model)
            byName.set(model.model, byName.has(model.model) ? null : model);
    }
    return (id?: string) =>
        id ? (byId.get(id) ?? byName.get(id) ?? undefined) : undefined;
}

export class RoutingSettingsError extends Error {}

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
    return status.models.some(
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

export function sameRouting(a: BYOKRouting, b: BYOKRouting): boolean {
    return (
        a.defaultModelId === b.defaultModelId &&
        a.fallbackModelId === b.fallbackModelId &&
        [
            ...new Set([
                ...Object.keys(a.taskOverrides ?? {}),
                ...Object.keys(b.taskOverrides ?? {}),
            ]),
        ].every(
            (task) =>
                a.taskOverrides?.[task as LlmTask] ===
                b.taskOverrides?.[task as LlmTask],
        )
    );
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
    const models = new Map(
        status.models.map((model) => [model.modelId, model]),
    );
    const candidate = candidates.find((id) => {
        const model = id ? models.get(id) : undefined;
        return (
            model &&
            !model.managed &&
            model.capabilities &&
            capabilityGate(task, model.capabilities).ok
        );
    });
    return (candidate ? models.get(candidate) : undefined)?.resolvable
        ? candidate
        : undefined;
}
