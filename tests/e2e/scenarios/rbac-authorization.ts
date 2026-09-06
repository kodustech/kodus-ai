import * as fs from "fs";
import { join } from "path";

import { http } from "../lib/http.js";
import {
    NON_OWNER_ROLES,
    RbacRole,
    setupRbacOrg,
} from "../lib/rbac-provision.js";
import type { RunContext, Scenario, TargetContext } from "../lib/types.js";

// ---------------------------------------------------------------------------
// RBAC authorization matrix (full-stack, COMPREHENSIVE — backend).
//
// Replays the committed RBAC manifest
// (apps/api/src/controllers/__tests__/rbac-matrix.manifest.json) against a
// real, provisioned target, exercising JwtAuthGuard → PolicyGuard →
// PermissionsAbilityFactory over HTTP. The manifest is the SINGLE SOURCE OF
// TRUTH (same extractor as authorization-matrix.spec.ts); a jest drift-guard
// keeps it in sync, so this live test and the static grid can never disagree.
//
// IDEMPOTENT BY CONSTRUCTION (safe on shared QA, cannot touch other orgs):
//   - GET endpoints are read-only — fired for every role.
//   - Mutations (POST/PUT/PATCH/DELETE) are fired ONLY for roles the manifest
//     marks `deny`, asserting the 403 PolicyGuard returns BEFORE the handler
//     runs — so no mutation handler ever executes. The allow-side of mutations
//     is proven by the static manifest, never fired live.
//
// Tier-gated endpoints (Cockpit, SSO) sit behind a SEPARATE guard that 403s
// regardless of role when the org isn't licensed. OWNER is the canary: an owner
// 401/403 can only be a non-RBAC guard, so those endpoints are reported and
// skipped (never silently passed); if most are owner-blocked the run fails.
// ---------------------------------------------------------------------------

type ManifestEntry = {
    key: string;
    httpMethod: string;
    urlPath: string;
    expected: Record<RbacRole, "allow" | "deny">;
};

// e2e scripts run with cwd = tests/e2e (see package.json).
const MANIFEST_PATH = join(
    process.cwd(),
    "..",
    "..",
    "apps",
    "api",
    "src",
    "controllers",
    "__tests__",
    "rbac-matrix.manifest.json",
);

function loadManifest(): ManifestEntry[] {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as ManifestEntry[];
}

// Scheduled self-hosted matrix: the tested DOCKER image is the newest
// PUBLISHED release, but the committed RBAC manifest always reflects main.
// Any endpoint added since the last release is absent from the image, so the
// live probe gets 404 (route doesn't exist yet) instead of the manifest's
// expected 403. That is a "not yet released" gap, not an RBAC regression.
// PR / release-train runs test an image built from the same commit as the
// manifest, where a 404 is a real mismatch and must keep failing. The cron
// sets RBAC_ALLOW_MISSING_ROUTE=1 to permit this one narrow case; every other
// workflow leaves it unset so genuine regressions still fail (#1696).
const ALLOW_MISSING_ROUTE =
    process.env.RBAC_ALLOW_MISSING_ROUTE === "1";

// Replace `:param` segments with a throwaway value so the request reaches the
// guards. PolicyGuard runs before validation, so a downstream 400/404 on a
// dummy id still reflects "allowed by policy" (not 401/403).
function concreteUrl(urlPath: string): string {
    return urlPath.replace(/:[A-Za-z0-9_]+/g, "1");
}

async function hit(
    target: TargetContext,
    entry: ManifestEntry,
    token: string,
): Promise<number> {
    // SSE endpoints are GET over HTTP; the guard runs before the stream opens,
    // so a denied role still gets a clean 403. They're classified non-GET below
    // (deny-only), so the allow-side never streams.
    const verb = (entry.httpMethod === "SSE" ? "GET" : entry.httpMethod) as
        | "GET"
        | "POST"
        | "PUT"
        | "PATCH"
        | "DELETE";
    const res = await http(`${target.apiBaseUrl}${concreteUrl(entry.urlPath)}`, {
        method: verb,
        headers: { Authorization: `Bearer ${token}` },
        body: verb === "GET" ? undefined : {},
        timeoutMs: 20_000,
    });
    return res.status;
}

// Guards run before handlers. With a definitely-invalid bearer token the
// JwtAuthGuard answers 401 when a route EXISTS (it is found and rejects the
// token) and the router answers 404 when it is ABSENT. Either way no handler
// runs, so this probe has zero side effects — it is the mutation analogue of
// the GET branch's owner canary, used to attribute a deny-role 404 to a
// release gap only when the route is genuinely missing (#1696, rbac:146).
const UNAUTHENTICATED_PROBE_TOKEN = "orca-rbac-probe-invalid-token";

async function routeExists(
    target: TargetContext,
    entry: ManifestEntry,
): Promise<boolean> {
    const status = await hit(target, entry, UNAUTHENTICATED_PROBE_TOKEN);
    return status !== 404;
}

export const rbacAuthorization: Scenario = {
    id: "rbac-authorization",
    title: "RBAC: every gated endpoint enforces the manifest verdict per role",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github", "github-app"], // RBAC is provider-agnostic; one provider suffices
        license: ["trial", "paid", "license-paid"],
    },
    timeoutSec: 900,
    async run(ctx: RunContext) {
        const manifest = loadManifest();
        ctx.assert(
            manifest.length > 30,
            `manifest looks empty (${manifest.length}) — regenerate with UPDATE_RBAC_MANIFEST=1`,
        );

        const { sessions } = await setupRbacOrg(ctx);
        const tokenOf = (role: RbacRole) =>
            sessions.find((s) => s.role === role)!.accessToken;

        const failures: string[] = [];
        const tierSkipped: string[] = [];
        // Distinct missing endpoints (deduped — a mutation can add a 404 per
        // deny-role, up to 3x, which must not inflate the gap ratio below).
        const missingEndpoints = new Set<string>();
        const releaseGapSkipped: string[] = [];
        let asserted = 0;
        let mutationAllowDeferred = 0;
        let getCount = 0;

        for (const entry of manifest) {
            // Mutations: fire ONLY deny-roles and assert the pre-handler 403
            // (zero side effect, idempotent). Allow-side is static-only.
            if (entry.httpMethod !== "GET") {
                for (const role of NON_OWNER_ROLES) {
                    if (entry.expected[role] !== "deny") {
                        mutationAllowDeferred++;
                        continue;
                    }
                    const status = await hit(ctx.target, entry, tokenOf(role));
                    if (status === 404 && ALLOW_MISSING_ROUTE) {
                        // Endpoint added on main but not yet in the released
                        // image (scheduled-matrix-only narrow case #1696).
                        // Confirm the route is genuinely absent first — a route
                        // that EXISTS but denied a deny-role 404 instead of 403
                        // must stay a real failure (rbac:146).
                        if (await routeExists(ctx.target, entry)) {
                            failures.push(
                                `${role} should be DENIED on ${entry.httpMethod} ${entry.urlPath} (expected 403, got ${status} — route exists, this is not a release gap)`,
                            );
                            continue;
                        }
                        const key = `${entry.httpMethod} ${entry.urlPath}`;
                        missingEndpoints.add(key);
                        releaseGapSkipped.push(
                            `${role} DENIED ${key} (404 — route not in tested release image)`,
                        );
                        continue;
                    }
                    if (status !== 403) {
                        failures.push(
                            `${role} should be DENIED on ${entry.httpMethod} ${entry.urlPath} (expected 403, got ${status})`,
                        );
                    }
                    asserted++;
                }
                continue;
            }

            // GET (read-only). OWNER canary skips non-RBAC (tier) guards.
            getCount++;
            const ownerStatus = await hit(ctx.target, entry, tokenOf("owner"));
            if (ownerStatus === 404 && ALLOW_MISSING_ROUTE) {
                // Route added on main but absent from the released image
                // (scheduled-matrix-only narrow case #1696).
                missingEndpoints.add(`GET ${entry.urlPath}`);
                releaseGapSkipped.push(
                    `GET ${entry.urlPath} (404 — route not in tested release image)`,
                );
                continue;
            }
            if (ownerStatus === 401 || ownerStatus === 403) {
                tierSkipped.push(
                    `${entry.httpMethod} ${entry.urlPath} (owner ${ownerStatus})`,
                );
                continue;
            }

            for (const role of NON_OWNER_ROLES) {
                const status = await hit(ctx.target, entry, tokenOf(role));
                const expected = entry.expected[role];
                if (expected === "deny" && status !== 403) {
                    failures.push(
                        `${role} should be DENIED on ${entry.httpMethod} ${entry.urlPath} (expected 403, got ${status})`,
                    );
                } else if (
                    expected === "allow" &&
                    (status === 401 || status === 403)
                ) {
                    failures.push(
                        `${role} should be ALLOWED on ${entry.httpMethod} ${entry.urlPath} (got ${status})`,
                    );
                }
                asserted++;
            }
        }

        if (tierSkipped.length) {
            console.log(
                `[rbac] ${tierSkipped.length} GET endpoint(s) skipped — owner blocked by a non-RBAC guard (org not tier-unlocked?):\n  ${tierSkipped.join("\n  ")}`,
            );
        }
        if (releaseGapSkipped.length) {
            console.log(
                `[rbac] ${releaseGapSkipped.length} manifest endpoint(s) 404 (not in tested release image) — tolerated because RBAC_ALLOW_MISSING_ROUTE=1 (scheduled matrix tests the last published release against a main-refreshed manifest):\n  ${releaseGapSkipped.join("\n  ")}`,
            );
        }
        console.log(
            `[rbac] live verdicts asserted: ${asserted} (all GET allow/deny + every mutation deny). Mutation allow-side (${mutationAllowDeferred}) is static-only, so the run stays idempotent.`,
        );

        ctx.assert(
            failures.length === 0,
            `RBAC mismatches (${failures.length}):\n  ${failures.join("\n  ")}`,
        );
        // Safety: the release-gap tolerance exists for the NARROW case of a
        // handful of endpoints added since the last release. If most endpoints
        // 404, that's a misprovisioned image (wrong tag), not a gap — fail so
        // the cron can't report green against a broken target (#1696). The
        // guard counts DISTINCT missing endpoints (one per route), not the
        // per-deny-role 404s, so the ratio can't be inflated (rbac:170).
        ctx.assert(
            !ALLOW_MISSING_ROUTE ||
                missingEndpoints.size <= manifest.length / 2,
            `RBAC_ALLOW_MISSING_ROUTE=1 was set but ${missingEndpoints.size}/${manifest.length} endpoints 404 — the tested image is likely the wrong tag, not a release gap.`,
        );
        ctx.assert(
            getCount > 0 && tierSkipped.length < getCount / 2,
            `Over half the GET endpoints (${tierSkipped.length}/${getCount}) had owner blocked — the test org is not trial/licensed, so tier-gated RBAC was NOT validated. Run against a trial (fresh cloud) or licensed target.`,
        );

        return {
            endpoints: manifest.length,
            cellsAsserted: asserted,
            mutationAllowDeferred,
            tierSkipped: tierSkipped.length,
        };
    },
};

export default rbacAuthorization;
