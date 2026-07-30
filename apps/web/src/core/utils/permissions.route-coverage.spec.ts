import * as fs from "fs";
import * as path from "path";
import { ResourceType } from "@services/permissions/types";

import { resourceRoutes } from "./permissions.routes";

/**
 * Guard-rail in BOTH directions, so the middleware role guard can never let a
 * page silently 403 every non-owner role (the TokenUsage / Helpdesk class of
 * bug):
 *
 *   A. resource -> route: every ResourceType either maps to a route in
 *      `resourceRoutes` or is listed as intentionally routeless. Catches the
 *      backend gaining a resource the frontend never learned about.
 *
 *   B. route -> resource: every `page.tsx` under app/(app) resolves to a route
 *      that is matched by some `resourceRoutes` entry (or is explicitly
 *      owner-only). Catches a page that exists on disk but no role mapping
 *      reaches — which `canAccessRoute` would redirect to /forbidden for every
 *      non-owner. This is the direction the old test was missing: TokenUsage
 *      had a real /token-usage page but sat in ROUTELESS_RESOURCES, so the
 *      guard-rail was told to ignore the one broken resource.
 */

const APP_DIR = path.join(__dirname, "..", "..", "app", "(app)");

// Resources surfaced INSIDE another page (a tab/section), with no route of
// their own in `resourceRoutes`. Membership here is asserted against the
// filesystem by direction B below — you cannot hide a real page in here.
const ROUTELESS_RESOURCES = new Set<string>([
    "KodyRules", // shown inside code-review / library pages
    "IssuesSettings", // shown inside the issues page
]);

// Routes that, by design, only the OWNER reaches (canAccessRoute early-returns
// for owner). Anything not matched by resourceRoutes AND not listed here is a
// bug. Empty today — add with a comment explaining the product decision.
const OWNER_ONLY_ROUTES = new Set<string>([]);

function resourceMembers(): string[] {
    // String enum -> Object.keys returns the member names (All, TokenUsage, …)
    return Object.keys(ResourceType);
}

function isRouted(member: string): boolean {
    const value = (ResourceType as Record<string, string>)[member];
    return resourceRoutes[value as ResourceType] !== undefined;
}

/** All route patterns, flattened across every resource. */
const ALL_PATTERNS: string[] = Object.values(resourceRoutes).flat();

function pathMatchesAnyPattern(pathname: string): boolean {
    return ALL_PATTERNS.some((route) => {
        if (route.endsWith("/*")) {
            const base = route.slice(0, -2);
            // Exact or true sub-path only — a sibling sharing the prefix
            // (e.g. /cli-reviews vs /cli) must not count as covered.
            return pathname === base || pathname.startsWith(base + "/");
        }
        return pathname === route;
    });
}

/** Turn a page.tsx absolute path into its public route pathname. */
function fileToRoute(absFile: string): string {
    const rel = absFile.slice(APP_DIR.length).replace(/[/\\]page\.tsx$/, "");
    const segments = rel
        .split(/[/\\]/)
        .filter(Boolean)
        // Route groups `(app)` and intercepting markers `(.)`, `(..)` are not
        // URL segments.
        .filter((seg) => !/^\(.*\)$/.test(seg))
        // Parallel route slots `@modal`, `@bugRatioAnalytics` are not URL
        // segments either — their page renders at the parent route.
        .filter((seg) => !seg.startsWith("@"))
        // Dynamic `[id]` / catch-all `[...slug]` -> a concrete dummy segment so
        // prefix matching behaves like a real request.
        .map((seg) => (seg.startsWith("[") ? "x" : seg));
    return "/" + segments.join("/");
}

function collectPageRoutes(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...collectPageRoutes(full));
        } else if (entry.name === "page.tsx") {
            out.push(fileToRoute(full));
        }
    }
    return out;
}

describe("permissions route coverage", () => {
    it("A. every ResourceType is routed or explicitly routeless", () => {
        const uncovered = resourceMembers().filter(
            (member) =>
                !isRouted(member) && !ROUTELESS_RESOURCES.has(member),
        );
        expect(uncovered).toEqual([]);
    });

    it("B. every page.tsx route is reachable by some role (not just owner)", () => {
        const routes = Array.from(new Set(collectPageRoutes(APP_DIR)));
        // Sanity: the walker actually found pages.
        expect(routes.length).toBeGreaterThan(0);

        const unreachable = routes.filter(
            (route) =>
                !pathMatchesAnyPattern(route) &&
                !OWNER_ONLY_ROUTES.has(route),
        );
        expect(unreachable).toEqual([]);
    });
});
