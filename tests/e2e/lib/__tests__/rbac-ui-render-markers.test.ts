import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RENDER_ROUTES } from "../../scenarios/rbac-ui-render.js";

const APP_DIR = resolve(
    import.meta.dirname,
    "..", "..", "..", "..",
    "apps", "web", "src", "app", "(app)",
);

/** Source of the route's own files, excluding nested dynamic segments. */
function routeSource(path: string): string {
    const dir = join(APP_DIR, ...path.replace(/^\//, "").split("/"));
    const out: string[] = [];
    const walk = (d: string) => {
        for (const name of readdirSync(d)) {
            const full = join(d, name);
            if (statSync(full).isDirectory()) {
                if (!name.startsWith("[")) walk(full);
            } else if (/\.tsx?$/.test(name)) {
                out.push(readFileSync(full, "utf8"));
            }
        }
    };
    walk(dir);
    return out.join("\n").toLowerCase();
}

// A renamed heading made /settings/git fail for every role, owner included,
// while the scenario was being skipped for an unrelated reason.
test("rbac-ui-render: each render marker still exists in its route's source", () => {
    for (const { path, marker } of RENDER_ROUTES) {
        if (!marker) continue;
        assert.ok(
            routeSource(path).includes(marker),
            `marker "${marker}" not found under apps/web/src/app/(app)${path}`,
        );
    }
});
