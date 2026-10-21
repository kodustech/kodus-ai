/**
 * Routes whose server components read the selected date range (and the
 * repository scope) from the URL, via `getSelectedDateRange()`.
 *
 * `proxy.ts` mirrors the request's query string into a header ONLY for these:
 * server components cannot read `searchParams` unless a page prop-drills it,
 * and mirroring globally would copy sensitive auth tokens (password-reset /
 * email-confirmation params) into a header reachable by every server component
 * and any logging layer.
 *
 * Missing a route here fails silently in the worst way: the page still
 * renders, but on the COOKIE's range while the picker's label follows the URL
 * — so a shared link, a Back navigation or a bookmark shows one window's
 * numbers under another window's dates. `date-range-routes.spec.ts` asserts
 * this list against the pages that actually read the range.
 */
export const dateRangeAwarePaths = [
    "/cockpit",
    "/token-usage",
    "/byok",
    "/review-suggestions",
];

/** True when the request's path is one whose server render reads the URL. */
export const isDateRangeAwarePath = (pathname: string): boolean =>
    dateRangeAwarePaths.some((path) => pathname.startsWith(path));
