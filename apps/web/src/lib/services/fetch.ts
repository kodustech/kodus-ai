import { redirect } from "next/navigation";
import { auth } from "src/core/config/auth";
import { isServerSide } from "src/core/utils/server-side";
import { addSearchParamsToUrl } from "src/core/utils/url";

export class TypedFetchError extends Error {
    statusCode: number;
    statusText: string;
    url: string;
    body?: unknown;

    static isError<T extends TypedFetchError>(
        this: new (...a: any[]) => T,
        error: unknown,
    ): error is T {
        return error instanceof this;
    }

    constructor(
        statusCode: number,
        statusText: string,
        url: string,
        body?: unknown,
    ) {
        super(`Request error: ${statusCode} ${statusText} in URL: ${url}`);
        this.name = "TypedFetchError";
        this.statusCode = statusCode;
        this.statusText = statusText;
        this.url = url;
        this.body = body;
    }
}

export const authorizedFetch = async <Data>(
    url: Parameters<typeof typedFetch>[0],
    config?: Parameters<typeof typedFetch>[1],
): Promise<Data> => {
    // Client calls go through the same-origin /api/proxy route, which injects
    // the Bearer token from the httpOnly session cookie server-side — so the
    // browser never fetches /api/auth/session or attaches the token itself.
    // Only server-side calls (which hit the backend directly, bypassing the
    // proxy) attach the token here, read from the session at request time.
    let headers = config?.headers;
    if (isServerSide) {
        const jwtPayload = await auth();
        headers = {
            ...headers,
            Authorization: `Bearer ${jwtPayload?.user.accessToken}`,
        };
    }

    try {
        const response = await typedFetch<{ data: Data }>(url, {
            ...config,
            headers,
        });

        return response.data;
    } catch (error1) {
        if (TypedFetchError.isError(error1)) {
            if (error1.statusCode === 401) {
                if (process.env.NODE_ENV !== "production") {
                    console.warn("[authorizedFetch] 401", {
                        url: error1.url,
                        statusText: error1.statusText,
                        body: error1.body,
                    });
                }

                if (isServerSide) redirect("/sign-out");
                return null as Data;
            }
        }

        // Propagar o erro para que o chamador possa tratar
        throw error1;
    }
};

export const typedFetch = async <Data>(
    url: string,
    config?: Parameters<typeof globalThis.fetch>[1] & {
        params?: Record<string, string | number | boolean | null | undefined>;
    },
): Promise<Data> => {
    const { params = {}, ...configRest } = config ?? {};

    const urlWithParams = addSearchParamsToUrl(url.toString(), params);

    try {
        const response = await fetch(urlWithParams, {
            ...configRest,
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                ...configRest.headers,
            },
        });

        if (!response.ok) {
            let errorBody: unknown = undefined;
            try {
                errorBody = await response.json();
            } catch {
                // ignore JSON parse errors, keep body undefined
            }

            throw new TypedFetchError(
                response.status,
                response.statusText,
                urlWithParams,
                errorBody,
            );
        }

        return (await response.json()) as Data;
    } catch (error) {
        // Re-throw the error with more context if it's a network error
        if (
            error instanceof Error &&
            (error.message.includes("ENOTFOUND") ||
                error.message.includes("ECONNREFUSED"))
        ) {
            throw new Error(`Network error: ${error.message}`);
        }

        if (error instanceof TypeError) {
            throw new Error(
                `Network error while requesting ${urlWithParams}: ${error.message}`,
            );
        }
        throw error;
    }
};
