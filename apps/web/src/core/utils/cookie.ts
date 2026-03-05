import {
    deleteCookie,
    getCookie,
    hasCookie,
    setCookie,
    type OptionsType,
} from "cookies-next/client";

import type { LiteralUnion } from "../types";

export type CookieName = LiteralUnion<
    | "cockpit-selected-date-range"
    | "cockpit-selected-repository"
    | "global-selected-team-id"
    | "started-setup-from-new-setup-page"
    | "selectedTeam"
    | "onboarding-selected-pr-for-code-review"
    | "trial-finished-modal-closed"
>;

export const ClientSideCookieHelpers = (
    key: CookieName,
    options?: OptionsType,
) => {
    return {
        has: () => hasCookie(key, options),
        get: () => getCookie(key, options),
        set: (value: string) => setCookie(key, value, options),
        delete: () => deleteCookie(key, options),
    };
};
