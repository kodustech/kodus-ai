import { randomUUID } from "node:crypto";
import { ensureOk, http } from "../lib/http.js";
import type { RunContext, Scenario } from "../lib/types.js";

// Default live-review target: the trpc PR behind one of the seeded
// featured cards — small (~3.5 KB diff, well under the 10k-line / 80-file
// cap) and a merged PR, so its diff is immutable and the enqueue never
// trips `too_large`. Overridable for envs that curate a different set.
const DEFAULT_LIVE_PR_URL =
    process.env.PUBLIC_DEMO_PR_URL ??
    "https://github.com/trpc/trpc/pull/7280";

// Successful responses are wrapped by the API's global interceptor as
// { data, statusCode, type }; some error filters return flat bodies.
// Same unwrap the try-app client (apps/try/src/lib/api.ts) does.
function unwrap<T = any>(body: any): T {
    return (body?.data ?? body) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Public-demo API smoke. Unlike every other scenario this one is
// anonymous — no tenant, no provider integration, no onboarding. It hits
// the `/cli/public/*` surface the marketing site consumes:
//   1. featured grid (cached snapshots served by slug, instant)
//   2. live enqueue → poll → COMPLETED (the real review pipeline)
//
// It does NOT vary across provider/license, so `appliesTo` pins it to a
// single matrix coordinate (cloud × github × paid) — that makes it run
// exactly once per cloud matrix instead of fanning out across cells that
// would each re-exercise the identical anonymous path. Cloud-only: the
// public demo is a kodus.io marketing feature, not a self-hosted surface.
export const publicPrDemo: Scenario = {
    id: "public-pr-demo",
    title: "Public PR demo API: featured snapshot + live enqueue→poll→completed",
    priority: "P1",
    appliesTo: {
        target: ["cloud"],
        provider: ["github"],
        license: ["paid"],
    },
    // Generous: live review of a small public PR completes in ~1-3 min,
    // but worker queue depth on a shared QA box can add slack. The inner
    // poll budget (8 min) is the real gate; this is the outer kill.
    timeoutSec: 720,
    async run(ctx: RunContext) {
        const base = ctx.target.apiBaseUrl.replace(/\/$/, "");

        // ---- Featured grid (cached, deterministic when seeded) ----
        const listResp = ensureOk(
            await http(`${base}/cli/public/featured-reviews`),
            "GET featured-reviews",
        );
        const list = unwrap(listResp.body);
        const items: any[] = list?.items ?? [];

        // Always review the small, fixed default PR for the live path —
        // keeps latency low and independent of however the featured grid
        // happens to be sorted/seeded in this env.
        const livePrUrl = DEFAULT_LIVE_PR_URL;
        const featuredSeeded = items.length > 0;

        if (featuredSeeded) {
            const first = items[0];
            ctx.assert(
                typeof first.slug === "string" && first.slug.length > 0,
                "featured list item is missing a slug",
            );

            const detailResp = ensureOk(
                await http(
                    `${base}/cli/public/featured-reviews/${encodeURIComponent(first.slug)}`,
                ),
                `GET featured-reviews/${first.slug}`,
            );
            const detail = unwrap(detailResp.body);
            ctx.assert(
                detail?.pr?.prNumber,
                `featured "${first.slug}" detail is missing pr metadata`,
            );
            ctx.assert(
                typeof detail?.diff === "string" && detail.diff.length > 0,
                `featured "${first.slug}" detail is missing the raw diff`,
            );
            ctx.assert(
                detail?.result && Array.isArray(detail.result.issues),
                `featured "${first.slug}" detail is missing result.issues`,
            );

            // Unknown slug must 404 (not 200 with an empty body).
            const missing = await http(
                `${base}/cli/public/featured-reviews/__e2e-does-not-exist__`,
            );
            ctx.assert(
                missing.status === 404,
                `expected 404 for an unknown featured slug, got ${missing.status}`,
            );
        }

        // ---- Live enqueue → poll → completed (the real pipeline) ----
        // Fresh random fingerprint => first request is always under the
        // per-fingerprint rate limit (2/hour).
        const fingerprint = `e2e-${randomUUID()}`;
        const enqResp = await http(`${base}/cli/public/review-pr`, {
            method: "POST",
            body: { prUrl: livePrUrl, fingerprint },
        });
        ctx.assert(
            enqResp.status === 202,
            `POST review-pr expected 202, got ${enqResp.status}: ${enqResp.raw.slice(0, 300)}`,
        );
        const enq = unwrap(enqResp.body);
        const jobId = enq?.jobId;
        ctx.assert(
            typeof jobId === "string" && jobId.length > 0,
            "POST review-pr returned no jobId",
        );
        ctx.assert(
            enq?.pr?.prNumber,
            "POST review-pr returned no pr metadata to render immediately",
        );
        ctx.assert(
            typeof enq?.diff === "string",
            "POST review-pr returned no diff",
        );

        const POLL_TIMEOUT_MS = 8 * 60 * 1000;
        const pollStart = Date.now();
        let job: any;
        let polls = 0;
        for (;;) {
            await sleep(3000);
            polls++;
            const r = ensureOk(
                await http(
                    `${base}/cli/public/review/jobs/${encodeURIComponent(jobId)}?omit=payload`,
                ),
                `poll job ${jobId}`,
            );
            job = unwrap(r.body);
            if (job?.status === "COMPLETED" || job?.status === "FAILED") break;
            if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
                throw new Error(
                    `public review job ${jobId} still '${job?.status}' after ${Math.round((Date.now() - pollStart) / 1000)}s (${polls} polls)`,
                );
            }
        }

        const liveLatencySec = Math.round((Date.now() - pollStart) / 1000);
        ctx.assert(
            job.status === "COMPLETED",
            `live public review ended '${job.status}' (${job.error ?? "no error detail"}) after ${liveLatencySec}s`,
        );
        ctx.assert(
            job.result && Array.isArray(job.result.issues),
            "completed public review job is missing result.issues",
        );

        if (!featuredSeeded) {
            // Don't fail the cell over an ops gap — the live pipeline is the
            // hard signal here; the featured grid just isn't seeded in this
            // env. Surface it loudly in the evidence so it's visible.
            // eslint-disable-next-line no-console
            console.warn(
                "[public-pr-demo] no featured reviews seeded in this env — " +
                    "featured-grid assertions were skipped. Run `pnpm run featured-review:seed`.",
            );
        }

        return {
            featuredSeeded,
            featuredCount: items.length,
            featuredSlug: featuredSeeded ? items[0].slug : null,
            livePrUrl,
            liveJobId: jobId,
            liveStatus: job.status,
            liveIssues: job.result.issues.length,
            livePolls: polls,
            liveLatencySec,
        };
    },
};

export default publicPrDemo;
