import { authorizedFetch } from "@services/fetch";

import { KODUS_CREDITS_PATHS } from ".";
import type { KodusCreditCharge } from "./types";

export const listKodusCreditCharges = async (
    params: {
        limit?: number;
        before?: string;
        prNumber?: number;
    } = {},
) => {
    const response = await authorizedFetch<{ charges: KodusCreditCharge[] }>(
        KODUS_CREDITS_PATHS.CHARGES,
        {
            cache: "no-store",
            params: {
                ...(params.limit ? { limit: params.limit } : {}),
                ...(params.before ? { before: params.before } : {}),
                ...(typeof params.prNumber === "number"
                    ? { prNumber: params.prNumber }
                    : {}),
            },
        },
    );
    return response?.charges ?? [];
};
