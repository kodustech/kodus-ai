import { addSearchParamsToUrl } from "./url";

export type SuspenseFetchParams = {
    params: Record<string, string | number | boolean | undefined | null>;
};

/**
 * Builds the authorized fetch queryFn shared by `useSuspenseFetch` and
 * `useSuspenseFetchMany`. Lives in its own React-free module so the
 * network / parse / fallback semantics are unit-testable without pulling in
 * the auth provider, and so both the single- and multi-query hooks reuse the
 * EXACT same implementation (no second copy to drift).
 *
 * Error handling:
 * - Network error or invalid JSON: return fallbackData if provided, else throw
 * - 404: return fallbackData if provided (resource doesn't exist yet), else throw
 * - Other non-2xx: always throw
 */
export const buildAuthorizedSuspenseQueryFn = <T>(
    url: string,
    params: SuspenseFetchParams | undefined,
    accessToken: string | null | undefined,
    fallbackData: T | undefined,
) => {
    return async ({ signal }: { signal: AbortSignal }): Promise<T> => {
        const urlWithParams = addSearchParamsToUrl(url, params?.params);

        let response: Response;
        try {
            response = await fetch(urlWithParams, {
                signal,
                headers: { Authorization: `Bearer ${accessToken}` },
            });
        } catch (networkError) {
            if (fallbackData !== undefined) {
                return fallbackData;
            }
            throw new Error(`Network error fetching ${url}`);
        }

        const text = await response.text();

        let json: { statusCode: number; data: T | undefined };
        try {
            json = JSON.parse(text);
        } catch {
            if (fallbackData !== undefined) {
                return fallbackData;
            }
            throw new Error(`Invalid JSON response from ${url}`);
        }

        if (json.statusCode === 404) {
            if (fallbackData !== undefined) {
                return fallbackData;
            }
            throw new Error(`Resource not found: ${url}`);
        }

        if (json.statusCode !== 200 && json.statusCode !== 201) {
            throw new Error(
                `Request failed: ${url} returned status ${json.statusCode}`,
            );
        }

        return json.data as T;
    };
};
