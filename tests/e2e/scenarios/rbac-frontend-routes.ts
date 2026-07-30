import * as fs from "fs";
import { join } from "path";

import { http } from "../lib/http.js";
import {
    NON_OWNER_ROLES,
    RBAC_PASSWORD,
    RbacRole,
    setupRbacOrg,
} from "../lib/rbac-provision.js";
import type { RunContext, Scenario, TargetContext } from "../lib/types.js";

// ---------------------------------------------------------------------------
// RBAC frontend route guard (full-stack).
//
// This is the layer the #1229 bug actually lived in: the Next.js middleware
// (`canAccessRoute`) that redirects a non-owner role to /forbidden when its
// policy doesn't reach a page. The backend rbac-authorization scenario proves
// the API enforces; this proves the WEB middleware does, on the running server.
//
// Replays the committed frontend manifest
// (apps/web/src/core/utils/permissions.route-manifest.json) — derived from the
// real `canAccessRoute` over every app/(app) page, with a jest drift-guard.
// For each role it signs in through next-auth over HTTP (no brittle browser
// form), then GETs each page route and checks: `deny` => redirected to
// /forbidden; `allow` => anything else (200, or a non-/forbidden app redirect
// such as the tier gate bouncing /cockpit → /settings/git).
//
// Idempotent: only GETs page routes, performs no mutations beyond signing up
// its own throwaway org + users (shared with rbac-authorization via
// lib/rbac-provision).
// ---------------------------------------------------------------------------

type RouteEntry = { route: string; expected: Record<RbacRole, "allow" | "deny"> };

const MANIFEST_PATH = join(
    process.cwd(),
    "..",
    "..",
    "apps",
    "web",
    "src",
    "core",
    "utils",
    "permissions.route-manifest.json",
);

function loadRouteManifest(): RouteEntry[] {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as RouteEntry[];
}

// Minimal cookie jar: name -> value, serialized as a Cookie header.
type Jar = Map<string, string>;
function absorb(jar: Jar, headers: Headers): void {
    for (const c of headers.getSetCookie()) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
}
function cookieHeader(jar: Jar): string {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// All requests go through lib/http.ts — NOT bare fetch — for two
// load-bearing reasons: (1) http() injects the AWS WAF bypass header on
// qa.*.kodus.io hosts; without it the WAF intermittently 403s
// GitHub-hosted runner IPs with an nginx HTML page, which a bare
// `res.json()` surfaces as the useless "Unexpected token '<'" (the exact
// 2026-06-05 nightly failure). (2) http() retries transport errors and
// 429s, so a single connection reset doesn't fail 130+ route verdicts.

/** Sign in through next-auth (credentials provider) over HTTP; returns the
 *  authenticated cookie jar the Next middleware accepts. */
async function nextAuthLogin(
    web: string,
    email: string,
    password: string,
): Promise<Jar> {
    const jar: Jar = new Map();

    const csrfRes = await http<{ csrfToken?: string }>(
        `${web}/api/auth/csrf`,
        { redirect: "manual" },
    );
    absorb(jar, csrfRes.headers);
    const csrfToken = csrfRes.body?.csrfToken;
    if (csrfRes.status !== 200 || typeof csrfToken !== "string") {
        throw new Error(
            `GET /api/auth/csrf returned HTTP ${csrfRes.status} ` +
                `(${csrfRes.headers.get("content-type") ?? "no content-type"}) ` +
                `instead of a JSON csrfToken: ${csrfRes.raw.slice(0, 200)}`,
        );
    }

    const form = new URLSearchParams({
        csrfToken,
        email,
        password,
        redirect: "false",
        json: "true",
    });
    const cbRes = await http(`${web}/api/auth/callback/credentials`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookieHeader(jar),
        },
        body: form.toString(),
        redirect: "manual",
    });
    absorb(jar, cbRes.headers);

    // Auth.js v5 names the session cookie `authjs.session-token` over HTTP but
    // prefixes it `__Secure-authjs.session-token` over HTTPS (QA cloud), and
    // chunks it (`…-token.0`, `.1`) once the JWT grows past the 4KB cookie
    // limit. Match by substring — the same shape the proxy uses
    // (create-proxy-handler.ts) — so the check survives all three variants
    // instead of only the bare HTTP name.
    const hasSession = [...jar.keys()].some((k) =>
        k.includes("authjs.session-token"),
    );
    if (!hasSession) {
        throw new Error(
            `next-auth login for ${email} did not yield a session ` +
                `(HTTP ${cbRes.status}): ${cbRes.raw.slice(0, 200)}`,
        );
    }
    return jar;
}

/** "allow" unless the middleware redirected to /forbidden. */
async function routeVerdict(
    web: string,
    jar: Jar,
    route: string,
): Promise<"allow" | "deny"> {
    const res = await http(`${web}${route}`, {
        headers: { Cookie: cookieHeader(jar) },
        redirect: "manual",
    });
    const location = res.headers.get("location") ?? "";
    return res.status >= 300 && res.status < 400 && /\/forbidden\b/.test(location)
        ? "deny"
        : "allow";
}

export const rbacFrontendRoutes: Scenario = {
    id: "rbac-frontend-routes",
    title: "RBAC: the web middleware redirects to /forbidden per the route manifest",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github"],
        license: ["trial", "paid", "license-paid"],
    },
    timeoutSec: 600,
    async run(ctx: RunContext) {
        const manifest = loadRouteManifest();
        ctx.assert(
            manifest.length > 10,
            `route manifest looks empty (${manifest.length}) — regenerate with UPDATE_ROUTE_MANIFEST=1`,
        );

        const web = (ctx.target as TargetContext).webBaseUrl.replace(/\/$/, "");
        const { sessions } = await setupRbacOrg(ctx);

        const failures: string[] = [];
        let asserted = 0;

        for (const role of NON_OWNER_ROLES) {
            const { email } = sessions.find((s) => s.role === role)!;
            const jar = await nextAuthLogin(web, email, RBAC_PASSWORD);

            for (const entry of manifest) {
                const verdict = await routeVerdict(web, jar, entry.route);
                if (verdict !== entry.expected[role]) {
                    failures.push(
                        `${role} on ${entry.route}: expected ${entry.expected[role]}, got ${verdict}`,
                    );
                }
                asserted++;
            }
        }

        console.log(
            `[rbac-fe] ${asserted} route×role verdicts checked live against ${web}`,
        );
        ctx.assert(
            failures.length === 0,
            `Frontend route mismatches (${failures.length}):\n  ${failures.join("\n  ")}`,
        );

        return { routes: manifest.length, verdictsAsserted: asserted };
    },
};

export default rbacFrontendRoutes;
