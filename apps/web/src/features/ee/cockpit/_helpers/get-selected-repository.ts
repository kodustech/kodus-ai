import { cookies } from "next/headers";
import type { CookieName } from "src/core/utils/cookie";
import { getCurrentSearchParamsOnServerComponents } from "src/core/utils/headers";

import { COCKPIT_PARAM } from "../_constants";

export const getSelectedRepository = async (): Promise<string | null> => {
    const [cookieStore, searchParams] = await Promise.all([
        cookies(),
        getCurrentSearchParamsOnServerComponents(),
    ]);

    // URL wins. Presence of the param — even empty — is authoritative:
    // an empty value means "all repositories" (no repo filter).
    if (searchParams.has(COCKPIT_PARAM.repository)) {
        return searchParams.get(COCKPIT_PARAM.repository) || null;
    }

    const repositoryCookie = cookieStore.get(
        "cockpit-selected-repository" satisfies CookieName,
    );

    if (!repositoryCookie) return null;

    try {
        return JSON.parse(repositoryCookie.value) as string;
    } catch {
        return null;
    }
};
