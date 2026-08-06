"use server";

import { updateTag } from "next/cache";
import { cookies } from "next/headers";
import type { CookieName } from "src/core/utils/cookie";

export const setCockpitRepositoryCookie = async (repository: string) => {
    const cookieStore = await cookies();

    cookieStore.set(
        "cockpit-selected-repository" satisfies CookieName,
        JSON.stringify(repository),
    );

    // Read-your-writes: the cookie above drives the analytics fetches, so the
    // next render has to see the new repository, not a stale-while-revalidate copy.
    updateTag("cockpit-repository-dependent");
};
