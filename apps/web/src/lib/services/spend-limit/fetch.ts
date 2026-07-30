import { authorizedFetch } from "@services/fetch";
import { axiosAuthorized } from "src/core/utils/axios";

import { SPEND_LIMIT_PATHS } from ".";
import {
    SpendLimitConfigView,
    SpendLimitStatus,
    UpdateSpendLimitPayload,
} from "./types";

export const getSpendLimitConfig = async (teamId?: string) => {
    return await authorizedFetch<SpendLimitConfigView>(SPEND_LIMIT_PATHS.GET, {
        params: teamId ? { teamId } : {},
    });
};

export const getSpendLimitStatus = async () => {
    try {
        return await authorizedFetch<SpendLimitStatus | null>(
            SPEND_LIMIT_PATHS.STATUS,
            {},
        );
    } catch (error) {
        // The API's global transform interceptor turns a `null` handler result
        // into a 404 — and `evaluate()` returns null when no enabled spend
        // limit is configured. That's an expected "no limit" state, not an
        // error, so swallow the 404 and let the widget render nothing.
        if ((error as { statusCode?: number })?.statusCode === 404) {
            return null;
        }
        throw error;
    }
};

export const updateSpendLimit = async (payload: UpdateSpendLimitPayload) => {
    return await axiosAuthorized.post<SpendLimitConfigView>(
        SPEND_LIMIT_PATHS.UPDATE,
        payload,
    );
};
