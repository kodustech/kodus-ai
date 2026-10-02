import { cookies } from "next/headers";
import type { CookieName } from "src/core/utils/cookie";
import { getCurrentSearchParamsOnServerComponents } from "src/core/utils/headers";

import { COCKPIT_PARAM } from "../_constants";

export const getSelectedRepository = async (): Promise<{
    repository: string | null;
    repositoryId: string | null;
}> => {
    const [cookieStore, searchParams] = await Promise.all([
        cookies(),
        getCurrentSearchParamsOnServerComponents(),
    ]);

    // URL wins. Presence of the param — even empty — is authoritative:
    // an empty value means "all repositories" (no repo filter).
    if (searchParams.has(COCKPIT_PARAM.repository)) {
        const repository = searchParams.get(COCKPIT_PARAM.repository) || null;
        return {
            repository,
            repositoryId: repository
                ? searchParams.get(COCKPIT_PARAM.repositoryId) || null
                : null,
        };
    }

    const repositoryCookie = cookieStore.get(
        "cockpit-selected-repository" satisfies CookieName,
    );

    if (!repositoryCookie) return { repository: null, repositoryId: null };

    try {
        const parsed = JSON.parse(repositoryCookie.value) as
            | string
            | { repository?: string; repositoryId?: string | null };
        if (typeof parsed === "string") {
            return { repository: parsed, repositoryId: null };
        }
        return {
            repository: parsed.repository || null,
            repositoryId: parsed.repositoryId || null,
        };
    } catch {
        return { repository: null, repositoryId: null };
    }
};
