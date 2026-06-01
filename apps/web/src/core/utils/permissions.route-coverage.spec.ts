import * as fs from "fs";
import * as path from "path";

/**
 * Guard-rail: every ResourceType must either map to a route in
 * `resourceRoutes` (so the middleware role guard can gate it) or be listed as
 * intentionally routeless below. Adding a ResourceType without deciding its
 * frontend route fails this test — closing the drift gap where the backend
 * gained a resource the frontend never learned about.
 *
 * Reads source files (no imports) to avoid pulling `next/server` into jest.
 */

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..", "..");
const ENUM_FILE = path.join(
    REPO_ROOT,
    "libs/identity/domain/permissions/enums/permissions.enum.ts",
);
const PERMISSIONS_FILE = path.join(__dirname, "permissions.ts");

// Resources with no dedicated page — surfaced inside other pages, not routable.
const ROUTELESS_RESOURCES = new Set<string>([
    "KodyRules", // shown inside code-review / library pages
    "IssuesSettings", // shown inside the issues page
    "TokenUsage", // shown inside settings, no standalone route
]);

function resourceTypeMembers(): string[] {
    const src = fs.readFileSync(ENUM_FILE, "utf8");
    const block = src.match(/export enum ResourceType\s*\{([^}]*)\}/);
    if (!block) throw new Error("ResourceType enum not found");
    return [...block[1].matchAll(/(\w+)\s*=/g)].map((m) => m[1]);
}

function routedResources(): Set<string> {
    const src = fs.readFileSync(PERMISSIONS_FILE, "utf8");
    const block = src.match(/const resourceRoutes[^=]*=\s*\{([\s\S]*?)\n\};/);
    if (!block) throw new Error("resourceRoutes object not found");
    return new Set(
        [...block[1].matchAll(/\[ResourceType\.(\w+)\]/g)].map((m) => m[1]),
    );
}

describe("permissions route coverage", () => {
    it("every ResourceType is routed or explicitly routeless", () => {
        const routed = routedResources();
        const uncovered = resourceTypeMembers().filter(
            (member) =>
                !routed.has(member) && !ROUTELESS_RESOURCES.has(member),
        );

        expect(uncovered).toEqual([]);
    });
});
