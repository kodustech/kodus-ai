import { decodeJwt, decodeProtectedHeader } from "jose";
import type { JWT } from "next-auth/jwt";
import {
    CodeReviewGlobalConfig,
    FormattedConfig,
} from "src/app/(app)/settings/code-review/_types";
import invariant from "tiny-invariant";

import { type ApiRoute } from "../config/constants";
import { type LiteralUnion } from "../types";
import { apiProxyPath } from "../utils/api-proxy";
import { isSelfHosted } from "../utils/self-hosted";
import { isServerSide } from "./server-side";

export function pathToApiUrl(
    path: ApiRoute | string,
    params?: Record<string, string | number | boolean>,
): string {
    invariant(path, "Api path doesn't exist");

    if (params) {
        Object.keys(params).forEach((key) => {
            path = path.replace(`:${key}`, params[key].toString());
        });
    }

    // Dual-mode: server callers hit the upstream directly, client callers
    // route through the same-origin proxy so the internal hostname never
    // appears in the browser bundle. Any module-level call to
    // pathToApiUrl(...) used to bake `http://undefined/...` into the
    // client bundle because WEB_HOSTNAME_API / WEB_PORT_API were removed
    // from next.config.js's `env:` block by the runtime-config migration.
    if (!isServerSide) {
        return apiProxyPath(path);
    }

    let hostName = process.env.WEB_HOSTNAME_API;
    if (hostName === "localhost") {
        hostName =
            process.env.GLOBAL_API_CONTAINER_NAME || "kodus_api";
    }
    const port = process.env.WEB_PORT_API;

    // `internal: true` is the caller saying "this is a same-cluster
    // hop". `createUrl` honours that only when a port is set (Docker
    // compose / dev). On AWS, no port is set and `createUrl` falls
    // through to the public-domain heuristic (https, no port).
    return createUrl(hostName, port, path, { internal: true });
}

/**
 * Build a URL for a backend upstream.
 *
 * Pass `{ internal: true }` when the target is on the same Docker /
 * Kubernetes network as us (`kodus_api:3001`, `kodus-service-billing:3992`,
 * etc.) — then the function just assembles `http://host:port/path`.
 *
 * When `internal` is unset, the function falls back to a heuristic
 * (production + self-hosted with a non-localhost hostname → https with
 * no port) for backwards compatibility with any caller that still
 * points at a public domain directly. New code should always set
 * `internal` explicitly.
 */
export function createUrl(
    hostName?: string,
    port?: string,
    path?: string,
    options?: { internal?: boolean },
): string {
    const HTTP = "http://";
    const HTTPS = "https://";

    // If the hostName carries an explicit scheme, honor it regardless
    // of the internal/heuristic logic below.
    let schemeOverride: string | null = null;
    if (hostName?.startsWith(HTTP)) {
        schemeOverride = "http";
        hostName = hostName.slice(HTTP.length);
    } else if (hostName?.startsWith(HTTPS)) {
        schemeOverride = "https";
        hostName = hostName.slice(HTTPS.length);
    }

    const portPart = port ? `:${port}` : "";

    // Explicit internal hop: same-cluster http+port, no heuristics.
    // We require BOTH `internal` AND a port to take this path. The
    // proxy routes (billing, mcp, api/*) all set `internal: true`
    // unconditionally, but on AWS QA/prod the env doesn't ship
    // WEB_PORT_* (the upstream is a public domain fronted by an ALB
    // that terminates TLS on 443). Without `port`, treat the call as a
    // public-domain hop and fall through to the heuristic below — that
    // produces `https://<host><path>`, which is what the ALB expects.
    if (options?.internal && port) {
        return `${schemeOverride ?? "http"}://${hostName}${portPart}${path}`;
    }

    // Explicit scheme on the hostName overrides the public-URL
    // heuristic below — the caller signalled exactly what they want
    // (including whether to keep the port).
    if (schemeOverride) {
        return `${schemeOverride}://${hostName}${portPart}${path}`;
    }

    // Legacy heuristic path, kept for callers that pass a bare
    // customer-supplied hostname and want a public-facing URL.
    const isProduction = process.env.WEB_NODE_ENV === "production";
    if (isProduction || (isSelfHosted && hostName !== "localhost")) {
        return `https://${hostName}${path}`;
    }
    return `http://${hostName}${portPart}${path}`;
}

export function isJwtExpired(expirationDate: number) {
    const THRESHOLD = 300;
    const expirationInMilliseconds = expirationDate * 1000;
    return Date.now() > expirationInMilliseconds - THRESHOLD;
}

export function parseJwt(jwt: string | null | undefined): {
    headers: Record<string, any>;
    payload: JWT;
} | null {
    if (!jwt) return null;

    try {
        const headers = decodeProtectedHeader(jwt);
        const payload = decodeJwt(jwt) as JWT;

        if (!payload || !headers) return null;

        return { headers, payload };
    } catch (error) {
        console.warn("Error decoding jwt token:", error);
        return null;
    }
}

export function formatNameToAvatar(name: string) {
    if (!name) return "";
    const nameSplit = name?.split(" ");
    const lettersAvatar =
        nameSplit?.length === 1
            ? nameSplit[0]?.substring(0, 2)
            : nameSplit[0]?.substring(0, 1) + nameSplit[1]?.substring(0, 1);

    return lettersAvatar?.toUpperCase() ?? "";
}

export function greeting(name?: string) {
    const hour = new Date().getHours();
    let message = "";

    if (hour >= 6 && hour < 12) {
        message = "👋 Good morning";
    } else if (hour >= 12 && hour < 18) {
        message = "👋 Good afternoon";
    } else {
        message = "👋 Good evening";
    }

    if (name) message += ` ${name}`;
    message += "!";

    return message;
}

export const formatPeriodLabel = (period: string): string => {
    const labels: Record<string, string> = {
        today: "Today",
        yesterday: "Yesterday",
        threeDaysAgo: "3 days ago",
        fourDaysAgo: "4 days ago",
        fiveDaysAgo: "5 days ago",
        sixDaysAgo: "6 days ago",
        lastWeek: "Last week",
        twoWeeksAgo: "Two weeks ago",
        older: "Older",
        setup: "Setup",
    };

    return labels[period] || period;
};

export const codeReviewConfigRemovePropertiesNotInType = (
    config: Partial<CodeReviewGlobalConfig>,
) => {
    const newConfig: Partial<CodeReviewGlobalConfig> = {};
    const expectedKeys: LiteralUnion<keyof CodeReviewGlobalConfig>[] = [
        "automatedReviewActive",
        "showStatusFeedback",
        "reviewCadence",
        "baseBranches",
        "ignoredTitleKeywords",
        "ideRulesSyncEnabled",
        // Action picked in the toggle-off confirmation modal. Without it
        // here, the stripper would silently drop the field and the
        // backend would never see whether the user chose keep / pause /
        // delete — which produced the production bug where rules stayed
        // ACTIVE after the user chose Delete.
        "ideSyncDisableAction",
        "ignorePaths",
        "reviewOptions",
        "kodusConfigFileOverridesWebPreferences",
        "pullRequestApprovalActive",
        "suggestionControl",
        "summary",
        "isRequestChangesActive",
        "kodyRulesGeneratorEnabled",
        "kodyKnowledgeApproval",
        "runOnDraft",
        "codeReviewVersion",
        "enableCommittableSuggestions",
        // BYOK main-model override. Without it here the stripper would
        // silently drop the field and the backend would never persist the
        // selected model.
        "byokModel",
        // New v2 prompt overrides for categories/severity customization
        "v2PromptOverrides",
    ];

    expectedKeys.forEach((key) => {
        if (!config.hasOwnProperty(key)) return;
        newConfig[key as keyof typeof newConfig] = config[
            key as keyof typeof newConfig
        ] as any;
    });

    return newConfig;
};

// Used for tests, it simulates waiting for an specified amount of milliseconds
export const waitFor = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

// Trailing comma on the generic <T,> disambiguates from JSX for
// SWC/Turbopack's edge-runtime parser when this module is imported
// from middleware.ts.
export const unformatConfig = <T,>(node: FormattedConfig<T>): T => {
    const unformattedConfig: Partial<T> = {};

    (Object.keys(node) as (keyof T)[]).forEach((key) => {
        const property = node[key];

        if (property && typeof property === "object" && "value" in property) {
            unformattedConfig[key] = property.value;
        } else if (property && typeof property === "object") {
            // Nested object, recurse
            unformattedConfig[key] = unformatConfig(
                property as unknown as FormattedConfig<any>,
            ) as any;
        } else {
            // Primitive value, assign directly
            (unformattedConfig as any)[key] = property;
        }
    });

    return unformattedConfig as T;
};
