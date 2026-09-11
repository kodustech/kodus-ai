import { typedFetch } from "@services/fetch";
import { createUrl } from "src/core/utils/helpers";
import { isServerSide } from "src/core/utils/server-side";

/**
 * Billing service fetch utility.
 *
 * Dual-mode:
 *   - Server side: direct to the internal billing host
 *     (WEB_HOSTNAME_BILLING / GLOBAL_BILLING_CONTAINER_NAME).
 *   - Client side: through /api/proxy/billing/<path>, handled by the
 *     route in apps/web/src/app/api/proxy/billing/[...path]/route.ts.
 *     Keeps the internal hostname out of the client bundle.
 */
/** The shared secret billing requires on its `/credits/*` routes (money). */
export const creditsServiceTokenHeader = (): Record<string, string> => {
    const token = (process.env.API_CREDITS_SERVICE_TOKEN ?? "").trim();
    return token ? { "x-kodus-service-token": token } : {};
};

/** Attach it to a server-side request config, preserving everything else. */
const withServiceToken = <C extends { headers?: HeadersInit }>(
    config?: C,
): C => {
    const extra = creditsServiceTokenHeader();
    if (Object.keys(extra).length === 0) return (config ?? {}) as C;
    return {
        ...((config ?? {}) as C),
        headers: {
            ...((config?.headers as Record<string, string>) ?? {}),
            ...extra,
        },
    };
};

export const billingFetch = async <Data>(
    _url: Parameters<typeof typedFetch>[0],
    config?: Parameters<typeof typedFetch>[1],
): Promise<Data> => {
    let url: string;

    if (isServerSide) {
        let hostName = process.env.WEB_HOSTNAME_BILLING;
        if (hostName === "localhost") {
            hostName =
                process.env.GLOBAL_BILLING_CONTAINER_NAME ||
                "kodus-service-billing";
        }
        const port = process.env.WEB_PORT_BILLING;
        // Internal hop: always http + port, no protocol guessing. The
        // old `containerName: hostName` trick is gone now that
        // createUrl exposes this flag directly.
        url = createUrl(hostName, port, `/api/billing/${_url}`, {
            internal: true,
        });
        // `/credits/*` on billing requires the shared service token (money
        // routes; the browser proxy denies them outright). Sent on every
        // server-side call — this branch is server-only.
    } else {
        const path = _url.toString();
        const normalized = path.startsWith("/") ? path : `/${path}`;
        url = `/api/proxy/billing${normalized}`;
    }

    try {
        // `/credits/*` on billing requires the shared service token (money
        // routes; the browser proxy denies them outright). Only the
        // server-side branch can carry it — `isServerSide` above.
        return typedFetch(
            url,
            isServerSide ? withServiceToken(config) : config,
        );
    } catch {
        return null as Data;
    }
};

/** A billing call that failed with an HTTP status (server-side only). */
export class BillingHttpError extends Error {
    constructor(
        public readonly status: number,
        public readonly body: unknown,
    ) {
        super(`billing HTTP ${status}`);
        this.name = "BillingHttpError";
    }
}

/**
 * Server-side billing call that THROWS on a non-2xx answer (with the status
 * and body) instead of resolving null like `billingFetch`. For mutations
 * whose failure the UI must tell apart — a 409 "no saved card" is not the
 * same as "saved".
 */
export const billingRequest = async <Data>(
    path: string,
    init: {
        method: "GET" | "POST" | "DELETE";
        body?: unknown;
        params?: Record<string, string>;
    },
): Promise<Data> => {
    if (!isServerSide) {
        throw new Error("billingRequest is server-side only");
    }
    let hostName = process.env.WEB_HOSTNAME_BILLING;
    if (hostName === "localhost") {
        hostName =
            process.env.GLOBAL_BILLING_CONTAINER_NAME ||
            "kodus-service-billing";
    }
    const port = process.env.WEB_PORT_BILLING;
    const query = init.params
        ? `?${new URLSearchParams(init.params).toString()}`
        : "";
    const url = createUrl(hostName, port, `/api/billing/${path}${query}`, {
        internal: true,
    });
    const response = await fetch(url, {
        method: init.method,
        headers: {
            "Content-Type": "application/json",
            ...creditsServiceTokenHeader(),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        cache: "no-store",
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch (error) {
        // Keep the raw body as the payload, but never silently: a non-JSON
        // answer from billing is a symptom worth finding in the logs.
        console.warn("[billing] non-JSON response body", {
            path,
            status: response.status,
            bodyPreview: text.slice(0, 200),
            error: error instanceof Error ? error.message : String(error),
        });
        parsed = text;
    }
    if (!response.ok) throw new BillingHttpError(response.status, parsed);
    return parsed as Data;
};
