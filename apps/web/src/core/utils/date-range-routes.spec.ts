import * as fs from "fs";
import * as path from "path";

import { dateRangeAwarePaths, isDateRangeAwarePath } from "./date-range-routes";

/**
 * Guard-rail for the class of bug this list exists to prevent: a page reads the
 * date range from the URL, the proxy does not mirror the query string for its
 * route, and the screen renders the COOKIE's window under the URL's dates —
 * numbers that never move while the picker's label does.
 *
 * Direction: page -> list. Every route under app/(app) whose render graph
 * reaches `getSelectedDateRange()` must be covered by `dateRangeAwarePaths`.
 */

const SRC = path.join(__dirname, "..", "..");
const APP_DIR = path.join(SRC, "app", "(app)");
const READER = "getSelectedDateRange";

const ALIASES: Array<[RegExp, string]> = [
    [/^@services$/, "lib/services"],
    [/^@services\//, "lib/services/"],
    [/^@hooks\//, "core/hooks/"],
    [/^@components\//, "core/components/"],
    [/^@providers\//, "core/providers/"],
    [/^@config\//, "core/config/"],
    [/^src\//, ""],
];

/** Resolve an import specifier to a file inside apps/web/src, or null. */
function resolveImport(fromFile: string, spec: string): string | null {
    let candidate: string | null = null;
    if (spec.startsWith(".")) {
        candidate = path.resolve(path.dirname(fromFile), spec);
    } else {
        for (const [pattern, replacement] of ALIASES) {
            if (pattern.test(spec)) {
                candidate = path.join(SRC, spec.replace(pattern, replacement));
                break;
            }
        }
    }
    if (!candidate) return null;

    for (const suffix of [
        "",
        ".ts",
        ".tsx",
        ".js",
        "/index.ts",
        "/index.tsx",
    ]) {
        const file = candidate + suffix;
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
    return null;
}

const IMPORT_RE = /from\s+["']([^"']+)["']/g;

/** True when this module, or anything it imports, calls the reader. */
function readsDateRange(file: string, seen = new Set<string>()): boolean {
    if (seen.has(file)) return false;
    seen.add(file);

    const source = fs.readFileSync(file, "utf8");
    // The helper's own module defines it; every other mention is a call site.
    if (source.includes(READER) && !file.endsWith("get-selected-date-range.ts"))
        return true;

    for (const match of source.matchAll(IMPORT_RE)) {
        const next = resolveImport(file, match[1]);
        if (next && readsDateRange(next, seen)) return true;
    }
    return false;
}

/** Turn a page.tsx absolute path into its public route pathname. */
function fileToRoute(absFile: string): string {
    const rel = absFile.slice(APP_DIR.length).replace(/[/\\]page\.tsx$/, "");
    const segments = rel
        .split(/[/\\]/)
        .filter(Boolean)
        // Route groups `(app)` and parallel slots `@chart` are not URL segments
        // — a slot's page renders at its parent route.
        .filter((seg) => !/^\(.*\)$/.test(seg) && !seg.startsWith("@"))
        .map((seg) => (seg.startsWith("[") ? "x" : seg));
    return "/" + segments.join("/");
}

function collectPages(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectPages(full));
        else if (entry.name === "page.tsx") out.push(full);
    }
    return out;
}

describe("date-range route coverage", () => {
    const pages = collectPages(APP_DIR);

    it("finds the app router pages", () => {
        expect(pages.length).toBeGreaterThan(0);
    });

    it("every page that reads the range from the URL is mirrored by the proxy", () => {
        const uncovered = Array.from(
            new Set(
                pages
                    .filter((file) => readsDateRange(file))
                    .map((file) => fileToRoute(file)),
            ),
        ).filter((route) => !isDateRangeAwarePath(route));

        expect(uncovered).toEqual([]);
    });

    it("lists no route that no page reads the range on", () => {
        const routes = new Set(
            pages.filter((file) => readsDateRange(file)).map(fileToRoute),
        );
        const stale = dateRangeAwarePaths.filter(
            (listed) =>
                !Array.from(routes).some((route) => route.startsWith(listed)),
        );

        expect(stale).toEqual([]);
    });
});
