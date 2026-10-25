import { authorizedFetch } from "@services/fetch";

import { CODE_MANAGEMENT_API_PATHS } from "./types";

/**
 * Repositories whose webhook could not be created when the selection was last
 * saved. Nothing shows them in the UI otherwise: the save succeeds, and the
 * failure only reaches the server log, so the team keeps waiting for reviews
 * that never run.
 *
 * This lives on its own rather than beside the other code-management reads:
 * `authorizedFetch` reaches next-auth, and a spec that only exercises the
 * chunked save should not have to load it (#2003 review).
 */
export type WebhookCreationFailure = {
    reason: string;
    at: string;
};

export const getWebhookCreationFailures = async (
    teamId: string,
): Promise<Record<string, WebhookCreationFailure>> => {
    // Server components read this through the authorized server-side path:
    // axiosAuthorized attaches no bearer token, so the API's JWT guard
    // rejected every call and the alert never rendered (only reaches this
    // through the /settings/git page today).
    const response = await authorizedFetch<{
        failures: Record<string, WebhookCreationFailure>;
    }>(CODE_MANAGEMENT_API_PATHS.GET_WEBHOOK_CREATION_FAILURES, {
        params: { teamId },
    });

    return response?.failures ?? {};
};
