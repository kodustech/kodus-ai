"use client";

import { useSubscriptionContext } from "../_providers/subscription-context";

/**
 * Whether the org has an AI key of its own connected. Billing never learns
 * that — the key lives in the API's org parameters — so the app layout stamps
 * it onto the license as `byok`; read it from there.
 */
export const useHasAiKey = () => {
    const { license } = useSubscriptionContext();
    return (license as { byok?: boolean }).byok === true;
};
