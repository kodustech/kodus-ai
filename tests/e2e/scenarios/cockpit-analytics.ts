import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { http } from "../lib/http.js";
import { ensureLicenseSeat } from "../lib/onboarding.js";
import type { RunContext, Scenario } from "../lib/types.js";

// ---------------------------------------------------------------------------
// Cockpit analytics availability guard.
//
// Catches the self-hosted regression where the cockpit page showed "Analytics
// Not Available" despite a valid Enterprise license and a healthy Postgres
// warehouse: the web layout gated on `WEB_ANALYTICS_SECRET` (the x-api-key of
// the retired `kodus-service-analytics` microservice, shipped EMPTY on
// self-hosted) instead of the license tier. The legacy path is dead
// server-side (CockpitSourceResolver hard-returns INTERNAL) so the secret is
// vestigial — yet it blocked the whole page. The matrix never exercised
// analytics, so it slipped through for months.
//
// Two layers:
//   1. API probe — GET /cockpit/validate (the cockpit endpoint is itself the
//      authority on eligibility):
//        • 200 + numeric PR count → tier-eligible AND the analytics warehouse
//          (2nd TypeORM datasource + its migrations) is reachable.
//        • 403 "not on a supported tier" → the org isn't cockpit-eligible
//          (e.g. unlicensed self-hosted, or a managed cloud plan that's neither
//          teams_* nor enterprise_*) → SKIP, not fail.
//        • anything else → fail (warehouse down / app error).
//      We deliberately do NOT use the billing `validate-org-license` endpoint
//      to gate tier: it's cloud-only and 500s on self-hosted (no billing
//      service in the SH compose).
//   2. Browser render — /cockpit must NOT redirect to /settings/git (tier gate)
//      and must NOT render the "Analytics Not Available" card. This is the only
//      layer that exercises the web LAYOUT gate, i.e. the actual customer bug
//      (the vestigial WEB_ANALYTICS_SECRET block); the API probe passes right
//      through it. Reached only when layer 1 returned 200 (eligible).
// ---------------------------------------------------------------------------

const PLAYWRIGHT_DIR = resolve(import.meta.dirname, "..", "playwright");
const SPEC = resolve(PLAYWRIGHT_DIR, "cockpit-analytics.mjs");

export const cockpitAnalytics: Scenario = {
    id: "cockpit-analytics",
    title:
        "Cockpit analytics is available for a licensed org (warehouse up + page not gated)",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github"],
        // license-paid = the self-hosted Enterprise customer case (the
        // regression). paid/trial cover cloud. Tiers that legitimately can't
        // reach cockpit (free, community-byok, license-free) are excluded —
        // their "not available" is correct behavior, not a regression. Cells
        // whose tenant resolves to an ineligible tier at runtime self-skip via
        // the 403 branch below.
        license: ["paid", "trial", "license-paid"],
    },
    // Full onboarding (finishOnboarding polls up to 300s) + a browser render.
    timeoutSec: 900,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, "scenario requires a tenant");
        ctx.assert(existsSync(SPEC), `Playwright spec not found at ${SPEC}`);

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        // The (app) layout redirects every page to /setup until the team is
        // ACTIVE and finishOnboard is true — the browser render needs a fully
        // onboarded org, not just a signed-up one.
        await ctx.kodus.finishOnboarding(session, repo);
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        // ---- Layer 1: cockpit eligibility + warehouse reachability ----
        // Routed through the web's generic API proxy (/api/proxy/api/* →
        // apps/api). The cockpit endpoint's own tier guard tells us whether the
        // org is eligible — no separate (cloud-only) billing call.
        const validateUrl =
            `${ctx.target.webBaseUrl}/api/proxy/api/cockpit/validate` +
            `?organizationId=${encodeURIComponent(session.organizationId)}`;
        // apps/api wraps controller returns in the global TransformInterceptor
        // envelope `{ data, statusCode, type }`, so the cockpit payload lives
        // under `.data` (see cockpit.controller.ts header comment).
        const validateResp = await http<{
            data?: { hasData?: boolean; pullRequestsCount?: number };
        }>(validateUrl, {
            method: "GET",
            headers: { Authorization: `Bearer ${session.accessToken}` },
            timeoutMs: 30_000,
        });

        if (validateResp.status === 403) {
            // Not cockpit-eligible (unlicensed SH, or a non-teams/enterprise
            // cloud plan). The availability regression isn't provable here —
            // record why rather than emit a false red.
            ctx.skip(
                `cockpit not provable: /cockpit/validate 403 — ` +
                    `${validateResp.raw.slice(0, 200)}`,
            );
        }
        ctx.assert(
            validateResp.status === 200,
            `GET /cockpit/validate returned HTTP ${validateResp.status} ` +
                `(expected 200 — analytics warehouse datasource/migrations may ` +
                `be down): ${validateResp.raw.slice(0, 300)}`,
        );
        const payload = validateResp.body?.data;
        const count = payload?.pullRequestsCount;
        ctx.assert(
            typeof count === "number",
            `GET /cockpit/validate body missing numeric data.pullRequestsCount ` +
                `(warehouse query failed?): ${validateResp.raw.slice(0, 300)}`,
        );

        // ---- Layer 2: web page availability (the actual customer bug) ----
        const code = await new Promise<number>((done) => {
            const child = spawn("node", ["cockpit-analytics.mjs"], {
                cwd: PLAYWRIGHT_DIR,
                env: {
                    ...process.env,
                    WEB_URL: ctx.target.webBaseUrl,
                    EMAIL: ctx.tenant!.email,
                    PASSWORD: ctx.tenant!.password,
                    OUT_DIR: ctx.artifactDir,
                },
                stdio: ["ignore", "inherit", "inherit"],
            });
            child.on("close", (c) => done(c ?? -1));
        });
        ctx.assert(
            code === 0,
            `cockpit-analytics Playwright render failed (exit ${code}) — the ` +
                `/cockpit page was unavailable for a licensed org. See ` +
                `${ctx.artifactDir}.`,
        );

        // ---- Layer 3 (analytics-worker matrix only): the ingestion SERVICE runs --
        // Gated by ANALYTICS_WORKER_EXPECTED (set when vm.sh provisioned the
        // worker-analytics service via COMPOSE_PROFILES=analytics). Layers 1-2
        // only prove the page/warehouse are reachable — they'd pass even if the
        // ingestion cron never ran (the bug that left SH cockpits empty: the
        // analytics worker isn't deployed). Here we prove the SERVICE keeps the
        // warehouse fresh on its own: poll the PUBLIC health/runs endpoint until
        // a successful ingestion run appears. The cron writes an
        // analytics.ingestion_runs row every tick even when it scans 0 PRs, so
        // this needs no seeded data — only a live role=analytics worker.
        let ingestionRunObserved: boolean | undefined;
        if (process.env.ANALYTICS_WORKER_EXPECTED === "1") {
            const runsUrl = `${ctx.target.apiBaseUrl}/cockpit/health/runs`;
            const deadlineMs = Date.now() + 240_000; // ~2 ticks of a */2 cron
            let lastBody = "";
            ingestionRunObserved = false;
            while (Date.now() < deadlineMs) {
                const r = await http<{ data?: { lastOk?: unknown } }>(runsUrl, {
                    method: "GET",
                    timeoutMs: 20_000,
                });
                lastBody = r.raw.slice(0, 300);
                if (r.body?.data?.lastOk) {
                    ingestionRunObserved = true;
                    break;
                }
                await new Promise((res) => setTimeout(res, 15_000));
            }
            ctx.assert(
                ingestionRunObserved,
                `no successful analytics ingestion run within 4min — the ` +
                    `worker-analytics service (role=analytics) is likely absent ` +
                    `or crash-looping, so the cockpit warehouse never refreshes. ` +
                    `/cockpit/health/runs=${lastBody}`,
            );
        }

        return {
            pullRequestsCount: count,
            hasData: payload?.hasData ?? false,
            ingestionRunObserved,
            evidenceDir: ctx.artifactDir,
        };
    },
};

export default cockpitAnalytics;
