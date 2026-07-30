import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { RBAC_PASSWORD, setupRbacOrg } from "../lib/rbac-provision.js";
import type { RbacRole } from "../lib/rbac-provision.js";
import type { RunContext, Scenario } from "../lib/types.js";

// ---------------------------------------------------------------------------
// RBAC frontend RENDER evidence (real browser).
//
// The route-guard e2e (rbac-frontend-routes) proves the middleware's
// authorization (200 vs /forbidden). This proves the UI actually RENDERS: it
// drives a real Chromium per role (auth injected from a next-auth session
// minted over HTTP — no brittle form) and asserts on the rendered DOM that the
// "Token Usage" menu item shows only for allowed roles and the /token-usage
// screen renders for them while denied roles get a rendered /forbidden page.
// Records a video + screenshots per role into the run's artifact dir.
//
// Browser work lives in playwright/rbac-ui-render.mjs (run from the playwright
// workspace where `playwright` is installed); this scenario provisions the role
// users and spawns it. Menu-item assertions are skipped (logged) if the radix
// dropdown won't open in headless — the route-render assertion is the hard gate.
// ---------------------------------------------------------------------------

const PLAYWRIGHT_DIR = resolve(import.meta.dirname, "..", "playwright");
const SPEC = resolve(PLAYWRIGHT_DIR, "rbac-ui-render.mjs");

// Routes whose RENDER we prove in the browser, with a DOM marker that the
// screen actually painted (`null` = only assert allow-side is not /forbidden —
// cockpit's body is data-dependent charts with no stable heading). `notMarker`
// asserts a substring is ABSENT on the allow side — for /cockpit it catches the
// "Analytics Not Available" card the vestigial WEB_ANALYTICS_SECRET gate used to
// render (a 200 page, so the not-/forbidden check alone passed right through it).
//
// The allow/deny verdict per role is NOT defined here: it comes from the
// committed route manifest (permissions.route-manifest.json), itself derived
// from ROLE_POLICIES with a jest drift-guard — single source of truth, no
// duplicated permission matrix (same file rbac-frontend-routes replays).
// /user-logs is deliberately absent: the page is feature-gated (EE
// activity-logs) and redirects to /settings when off, so its render is
// environment-dependent, not role-dependent.
const RENDER_ROUTES: Array<{
    path: string;
    marker: string | null;
    notMarker?: string;
}> = [
    { path: "/token-usage", marker: "token usage" },
    { path: "/pull-requests", marker: "pull requests" },
    { path: "/settings/git", marker: "git settings" },
    { path: "/cockpit", marker: null, notMarker: "analytics not available" },
];

const MANIFEST_PATH = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "apps",
    "web",
    "src",
    "core",
    "utils",
    "permissions.route-manifest.json",
);

type ManifestEntry = {
    route: string;
    expected: Record<Exclude<RbacRole, "owner">, "allow" | "deny">;
};

/** Resolve each render route's per-role verdict from the committed manifest
 *  (owner is omitted there — it reaches everything by definition). */
function buildRouteChecks() {
    const manifest = JSON.parse(
        readFileSync(MANIFEST_PATH, "utf8"),
    ) as ManifestEntry[];
    const byRoute = new Map(manifest.map((m) => [m.route, m]));
    return RENDER_ROUTES.map(({ path, marker, notMarker }) => {
        const entry = byRoute.get(path);
        if (!entry) {
            throw new Error(
                `route ${path} not found in permissions.route-manifest.json — regenerate with UPDATE_ROUTE_MANIFEST=1`,
            );
        }
        return { path, marker, notMarker, expected: entry.expected };
    });
}

export const rbacUiRender: Scenario = {
    id: "rbac-ui-render",
    title: "RBAC: the web renders the right menu + screen vs /forbidden per role",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github"],
        license: ["trial", "paid", "license-paid"],
    },
    // Full onboarding (finishOnboarding polls up to 300s) + 4 roles ×
    // (menu check + 4 route renders) in a real browser.
    timeoutSec: 1200,
    async run(ctx: RunContext) {
        ctx.assert(existsSync(SPEC), `Playwright spec not found at ${SPEC}`);

        const { sessions, ownerEmail } = await setupRbacOrg(ctx);
        const roles = sessions.map((s) => ({ role: s.role, email: s.email }));

        // The (app) layout redirects ANY page to /setup until the team is
        // ACTIVE and platform_configs.finishOnboard is true — so the
        // allow-side render assertions need a fully onboarded org, not just
        // the signed-up one setupRbacOrg returns. Onboard it as the owner
        // (same flow code-review-basic uses).
        const ownerSession = await ctx.kodus.login({
            email: ownerEmail,
            password: RBAC_PASSWORD,
        });
        await ctx.kodus.registerIntegration(ownerSession);
        const repo = await ctx.kodus.registerRepo(ownerSession);
        await ctx.kodus.finishOnboarding(ownerSession, repo);

        const code = await new Promise<number>((done) => {
            const child = spawn("node", ["rbac-ui-render.mjs"], {
                cwd: PLAYWRIGHT_DIR,
                env: {
                    ...process.env,
                    WEB_URL: ctx.target.webBaseUrl,
                    PASSWORD: RBAC_PASSWORD,
                    ROLES_JSON: JSON.stringify(roles),
                    ROUTES_JSON: JSON.stringify(buildRouteChecks()),
                    OUT_DIR: ctx.artifactDir,
                },
                stdio: ["ignore", "inherit", "inherit"],
            });
            child.on("close", (c) => done(c ?? -1));
        });

        ctx.assert(
            code === 0,
            `rbac-ui-render Playwright spec failed (exit ${code}) — see logs + ${ctx.artifactDir}`,
        );
        return { evidenceDir: ctx.artifactDir, roles: roles.length };
    },
};

export default rbacUiRender;
