import { cookies } from "next/headers";
import type { CookieName } from "src/core/utils/cookie";

export const getSelectedRepository = async (): Promise<string | null> => {
    const cookieStore = await cookies();

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
