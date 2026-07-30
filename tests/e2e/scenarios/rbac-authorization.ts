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

export const rbacAuthorization: Scenario = {
    id: "rbac-authorization",
    title: "RBAC: every gated endpoint enforces the manifest verdict per role",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github"], // RBAC is provider-agnostic; one provider suffices
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
        console.log(
            `[rbac] live verdicts asserted: ${asserted} (all GET allow/deny + every mutation deny). Mutation allow-side (${mutationAllowDeferred}) is static-only, so the run stays idempotent.`,
        );

        ctx.assert(
            failures.length === 0,
            `RBAC mismatches (${failures.length}):\n  ${failures.join("\n  ")}`,
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
