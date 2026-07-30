import * as fs from "fs";
import * as path from "path";
import { UserRole } from "@enums";

import { canAccessRoute } from "./permissions.routes";

/**
 * Frontend route-access manifest the full-stack e2e replays.
 *
 * `permissions.route-manifest.json` is the committed snapshot of every
 * app/(app) page route × role → reachable/forbidden, computed from the REAL
 * middleware guard (`canAccessRoute`, the same code the Next middleware runs).
 * The live e2e (tests/e2e/scenarios/rbac-frontend-routes.ts) signs in per role
 * over HTTP and asserts the running web app redirects to /forbidden exactly
 * where this says `deny` — i.e. proves the #1229 class (a page reachable or
 * blocked for the wrong role) on the real server.
 *
 * This drift-guard fails CI if the routes or policy change without
 * regenerating. Regenerate after an intentional change:
 *   UPDATE_ROUTE_MANIFEST=1 yarn test --testPathPatterns="route-manifest" --no-coverage
 */

const APP_DIR = path.join(__dirname, "..", "..", "app", "(app)");
const MANIFEST_PATH = path.join(__dirname, "permissions.route-manifest.json");

const NON_OWNER_ROLES = [
    UserRole.BILLING_MANAGER,
    UserRole.REPO_ADMIN,
    UserRole.CONTRIBUTOR,
];

/** Turn a page.tsx absolute path into its public route pathname. */
function fileToRoute(absFile: string): string {
    const rel = absFile.slice(APP_DIR.length).replace(/[/\\]page\.tsx$/, "");
    const segments = rel
        .split(/[/\\]/)
        .filter(Boolean)
        .filter((seg) => !/^\(.*\)$/.test(seg)) // route groups / intercepts
        .filter((seg) => !seg.startsWith("@")) // parallel-route slots
        .map((seg) => (seg.startsWith("[") ? "x" : seg)); // dynamic -> dummy
    return "/" + segments.join("/");
}

function collectPageRoutes(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectPageRoutes(full));
        else if (entry.name === "page.tsx") out.push(fileToRoute(full));
    }
    return out;
}

type RouteEntry = { route: string; expected: Record<string, "allow" | "deny"> };

function buildRouteManifest(): RouteEntry[] {
    const routes = Array.from(new Set(collectPageRoutes(APP_DIR))).sort();
    return routes.map((route) => {
        const expected: Record<string, "allow" | "deny"> = {};
        for (const role of NON_OWNER_ROLES) {
            expected[role] = canAccessRoute({ role, pathname: route })
                ? "allow"
                : "deny";
        }
        return { route, expected };
    });
}

describe("frontend route manifest", () => {
    it("is in sync with the routes + policy (regenerate with UPDATE_ROUTE_MANIFEST=1)", () => {
        const manifest = buildRouteManifest();
        expect(manifest.length).toBeGreaterThan(10);

        const serialized = JSON.stringify(manifest, null, 2) + "\n";
        if (process.env.UPDATE_ROUTE_MANIFEST) {
            fs.writeFileSync(MANIFEST_PATH, serialized);
            return;
        }
        expect(fs.existsSync(MANIFEST_PATH)).toBe(true);
        expect(serialized).toEqual(fs.readFileSync(MANIFEST_PATH, "utf8"));
    });
});
