import { headers } from "next/headers";

export const CURRENT_PATH_HEADER = "x-current-path";
export const CURRENT_SEARCH_HEADER = "x-current-search";

// depends on middleware: https://github.com/vercel/next.js/issues/43704#issuecomment-1411186664
export const getCurrentPathnameOnServerComponents = async () =>
    (await headers()).get(CURRENT_PATH_HEADER);

// The request URL's query string, mirrored into a header by middleware
// (server components can't read `searchParams` unless it's prop-drilled
// from a page). Returns a `URLSearchParams` — empty when there is no
// query. The constructor strips a single leading "?" per spec.
export const getCurrentSearchParamsOnServerComponents = async () =>
    new URLSearchParams((await headers()).get(CURRENT_SEARCH_HEADER) ?? "");

/**
 * True when the current render serves the router's flight fetch — a
 * client-side navigation or a prefetch — rather than a full document load.
 * Lets a layout skip seeding data the client is about to fetch itself.
 *
 * Next strips its own `RSC` / `Next-Router-*` headers before both the proxy
 * and `headers()` run, so the flight fetch is told apart by what the browser
 * sends on its own: a document navigation negotiates `text/html`, a `fetch()`
 * does not.
 */
export const isClientNavigationOnServerComponents = async () => {
    const accept = (await headers()).get("accept") ?? "";
    return !accept.includes("text/html");
};
