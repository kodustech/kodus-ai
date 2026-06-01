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
    } else {
        const path = _url.toString();
        const normalized = path.startsWith("/") ? path : `/${path}`;
        url = `/api/proxy/billing${normalized}`;
    }

    try {
        return typedFetch(url, config);
    } catch {
        return null as Data;
    }
};
