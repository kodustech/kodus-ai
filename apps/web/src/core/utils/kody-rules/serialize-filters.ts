/**
 * Pure helpers for serializing/parsing the Kody Rules list filters into
 * URL query string params. Used to make filter state bookmarkable and to
 * survive page reloads. Keeping the helpers pure makes the round-trip
 * trivially testable.
 *
 * Param shape:
 *   ?q=<text>&origins=Auto-sync,Onboarding&severities=critical,high&onlyOrphans=1
 */
import {
    EMPTY_LIST_FILTERS,
    type ListFilters,
} from "./apply-filters";
import type { InferredRuleOrigin } from "./infer-origin";

const ALLOWED_ORIGINS: ReadonlySet<InferredRuleOrigin> = new Set([
    "Auto-sync",
    "Onboarding",
    "Kody-generated",
    "Library",
    "MCP/Agent",
    "CLI",
    "manual",
]);

const ALLOWED_SEVERITIES: ReadonlySet<string> = new Set([
    "critical",
    "high",
    "medium",
    "low",
]);

export const FILTER_PARAM_KEYS = {
    query: "q",
    origins: "origins",
    severities: "severities",
    kodySync: "kodySync",
    onlyOrphans: "onlyOrphans",
    withSyncErrors: "syncErrors",
    pausedOnly: "pausedOnly",
} as const;

export type SerializedFilters = {
    query: string;
    listFilters: ListFilters;
    onlyOrphans: boolean;
};

export const EMPTY_SERIALIZED: SerializedFilters = {
    query: "",
    listFilters: EMPTY_LIST_FILTERS,
    onlyOrphans: false,
};

function splitCsv(value: string | null | undefined): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

export function parseFiltersFromParams(
    params: URLSearchParams | null | undefined,
): SerializedFilters {
    if (!params) return EMPTY_SERIALIZED;

    const query = params.get(FILTER_PARAM_KEYS.query) ?? "";

    const origins = new Set<InferredRuleOrigin>();
    for (const raw of splitCsv(params.get(FILTER_PARAM_KEYS.origins))) {
        if (ALLOWED_ORIGINS.has(raw as InferredRuleOrigin)) {
            origins.add(raw as InferredRuleOrigin);
        }
    }

    const severities = new Set<string>();
    for (const raw of splitCsv(params.get(FILTER_PARAM_KEYS.severities))) {
        const normalized = raw.toLowerCase();
        if (ALLOWED_SEVERITIES.has(normalized)) {
            severities.add(normalized);
        }
    }

    const kodySync = params.get(FILTER_PARAM_KEYS.kodySync) === "1";
    const onlyOrphans = params.get(FILTER_PARAM_KEYS.onlyOrphans) === "1";
    const withSyncErrors =
        params.get(FILTER_PARAM_KEYS.withSyncErrors) === "1";
    const pausedOnly = params.get(FILTER_PARAM_KEYS.pausedOnly) === "1";

    return {
        query,
        listFilters: { origins, severities, kodySync, withSyncErrors, pausedOnly },
        onlyOrphans,
    };
}

/**
 * Mutates a URLSearchParams object so it reflects the given filter state.
 * Empty values are removed so the URL stays clean (no `?q=&origins=`).
 */
export function applyFiltersToParams(
    params: URLSearchParams,
    filters: SerializedFilters,
): URLSearchParams {
    if (filters.query) {
        params.set(FILTER_PARAM_KEYS.query, filters.query);
    } else {
        params.delete(FILTER_PARAM_KEYS.query);
    }

    if (filters.listFilters.origins.size > 0) {
        params.set(
            FILTER_PARAM_KEYS.origins,
            Array.from(filters.listFilters.origins).join(","),
        );
    } else {
        params.delete(FILTER_PARAM_KEYS.origins);
    }

    if (filters.listFilters.severities.size > 0) {
        params.set(
            FILTER_PARAM_KEYS.severities,
            Array.from(filters.listFilters.severities).join(","),
        );
    } else {
        params.delete(FILTER_PARAM_KEYS.severities);
    }

    if (filters.listFilters.kodySync) {
        params.set(FILTER_PARAM_KEYS.kodySync, "1");
    } else {
        params.delete(FILTER_PARAM_KEYS.kodySync);
    }

    if (filters.onlyOrphans) {
        params.set(FILTER_PARAM_KEYS.onlyOrphans, "1");
    } else {
        params.delete(FILTER_PARAM_KEYS.onlyOrphans);
    }

    if (filters.listFilters.withSyncErrors) {
        params.set(FILTER_PARAM_KEYS.withSyncErrors, "1");
    } else {
        params.delete(FILTER_PARAM_KEYS.withSyncErrors);
    }

    if (filters.listFilters.pausedOnly) {
        params.set(FILTER_PARAM_KEYS.pausedOnly, "1");
    } else {
        params.delete(FILTER_PARAM_KEYS.pausedOnly);
    }

    return params;
}
