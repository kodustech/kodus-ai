import type { RunContext, Scenario } from "../lib/types.js";
import { http } from "../lib/http.js";
import { pollUntil } from "../providers/base.js";
import { logger } from "../lib/log.js";

const log = logger("finish-onboarding-slo");

/**
 * Onboarding SLO (issue #1452 matrix-gaps item 6).
 *
 * finish-onboarding runs the per-repo Kody-rules generation + repo-file sync
 * SYNCHRONOUSLY inside the HTTP request. #1494 made that sync expensive (it now
 * calls the LLM), pushing the request past the cloud proxy's 60s read-timeout →
 * nginx 504 → the onboarding UI showed a spinner-then-error while the work
 * sometimes finished in the background. The shared finishOnboarding() e2e
 * helper INTENTIONALLY tolerates that (it polls kodyLearningStatus so every
 * other scenario survives a slow-but-eventually-consistent onboarding) — which
 * is exactly why no scenario measured the SLO itself. This one does the
 * opposite on purpose: a proxy-timeout status is a hard FAIL, and it also
 * asserts the two post-conditions nothing else checks — the ONBOARDING_REPO_
 * ANALYSIS path both flips kodyLearningStatus to `enabled` AND generates ≥1
 * rule.
 *
 * Cloud-only: the 60s budget is the cloud reverse-proxy's read-timeout. A
 * self-hosted operator's proxy config is their own, so the SLO is not asserted
 * there.
 */
export const finishOnboardingSlo: Scenario = {
    id: "finish-onboarding-slo",
    title:
        "finish-onboarding completes within the proxy window and enables Kody (no 504, rules generated)",
    priority: "P0",
    appliesTo: {
        target: ["cloud"],
        provider: ["github"],
        license: ["paid", "license-paid"],
    },
    timeoutSec: 300,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, "scenario requires a tenant");

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        // forceRecreate so the onboarding actually runs the analysis for THIS
        // run rather than short-circuiting on an already-onboarded repo.
        const repo = await ctx.kodus.registerRepo(session, {
            forceRecreate: true,
        });

        // The proxy's read-timeout. finish-onboarding MUST return within this
        // window; anything slower 504s the real onboarding UI.
        const PROXY_BUDGET_MS = 60_000;
        // Client cap is deliberately LARGER than the budget so we observe the
        // proxy's own verdict (a 504 status) instead of a client-side abort.
        const startMs = Date.now();
        const resp = await http(
            `${ctx.target.apiBaseUrl}/code-management/finish-onboarding`,
            {
                method: "POST",
                headers: { Authorization: `Bearer ${session.accessToken}` },
                body: {
                    teamId: session.teamId,
                    reviewPR: false,
                    repositoryId: String(repo.id),
                    repositoryName: repo.name ?? repo.full_name,
                },
                timeoutMs: 120_000,
            },
        );
        const elapsedMs = Date.now() - startMs;

        // The SLO assertion: NO proxy-timeout masking. A 502/503/504/524/408
        // (or any non-2xx) is the exact regression #1494 introduced and the
        // shared helper hides — fail it loudly here.
        ctx.assert(
            resp.status >= 200 && resp.status < 300,
            `finish-onboarding returned HTTP ${resp.status} after ${elapsedMs}ms ` +
                `(SLO: 2xx within the ${PROXY_BUDGET_MS}ms proxy window). A 5xx here is a ` +
                `proxy timeout — the synchronous LLM rule-generation exceeded the read-` +
                `timeout, which 504s the real onboarding UI. body=${JSON.stringify(resp.body)?.slice(0, 300)}`,
        );
        if (elapsedMs > PROXY_BUDGET_MS) {
            // Under budget on THIS proxy but over the canonical 60s — surface
            // as a soft signal (the run still passes on a 2xx) so trend watchers
            // see onboarding creeping toward the cliff before it 504s.
            log.warn(
                `finish-onboarding took ${elapsedMs}ms (>${PROXY_BUDGET_MS}ms budget) but returned ${resp.status} — approaching the proxy-timeout cliff`,
            );
        }

        // Post-condition 1: kodyLearningStatus flips to `enabled`. The status
        // write is the completion marker of generate-kody-rules; it can lag the
        // 2xx briefly, so poll a short window.
        const learningEnabled = await pollUntil<boolean>(
            async () => {
                const s = await readKodyLearningStatus(ctx, session).catch(
                    () => undefined,
                );
                return s === "enabled" ? true : null;
            },
            { intervalSec: 5, timeoutSec: 120 },
        );
        ctx.assert(
            learningEnabled === true,
            `kodyLearningStatus never reached "enabled" within 120s of a 2xx ` +
                `finish-onboarding — the analysis path did not complete (ONBOARDING_REPO_ANALYSIS).`,
        );

        // Post-condition 2: ≥1 Kody rule generated. The ONBOARDING_REPO_ANALYSIS
        // path is supposed to seed rules; a 0-rule "enabled" onboarding is the
        // silent half-failure no scenario caught.
        const ruleCount = await pollUntil<number>(
            async () => {
                const c = await countOrgKodyRules(ctx, session).catch(() => 0);
                return c > 0 ? c : null;
            },
            { intervalSec: 5, timeoutSec: 120 },
        );
        ctx.assert(
            (ruleCount ?? 0) >= 1,
            `finish-onboarding enabled Kody but generated 0 rules within 120s — ` +
                `the ONBOARDING_REPO_ANALYSIS rule-seeding produced nothing.`,
        );

        return {
            repoId: repo.id,
            finishOnboardingMs: elapsedMs,
            withinProxyBudget: elapsedMs <= PROXY_BUDGET_MS,
            httpStatus: resp.status,
            kodyLearningStatus: "enabled",
            rulesGenerated: ruleCount,
        };
    },
};

interface PlatformConfigsResponse {
    data?: { configValue?: { kodyLearningStatus?: string } };
    configValue?: { kodyLearningStatus?: string };
}

async function readKodyLearningStatus(
    ctx: RunContext,
    session: { teamId: string; accessToken: string },
): Promise<string | undefined> {
    const resp = await http<PlatformConfigsResponse>(
        `${ctx.target.apiBaseUrl}/parameters/find-by-key?key=platform_configs&teamId=${encodeURIComponent(session.teamId)}`,
        {
            headers: { Authorization: `Bearer ${session.accessToken}` },
            timeoutMs: 10_000,
        },
    );
    if (resp.status < 200 || resp.status >= 300) return undefined;
    const root = (resp.body ?? {}) as PlatformConfigsResponse;
    return (
        root.data?.configValue?.kodyLearningStatus ??
        root.configValue?.kodyLearningStatus
    );
}

/** Count Kody rules for the org (defensive walk of the listing shape). */
async function countOrgKodyRules(
    ctx: RunContext,
    session: { teamId: string; accessToken: string },
): Promise<number> {
    const resp = await http<any>(
        `${ctx.target.apiBaseUrl}/kody-rules/find-by-organization-id`,
        {
            headers: { Authorization: `Bearer ${session.accessToken}` },
            timeoutMs: 15_000,
        },
    );
    if (resp.status < 200 || resp.status >= 300) return 0;
    let count = 0;
    const walk = (n: unknown): void => {
        if (Array.isArray(n)) {
            for (const item of n) walk(item);
            return;
        }
        if (n && typeof n === "object") {
            const obj = n as Record<string, unknown>;
            // A rule object has a uuid + rule/title — count those leaves.
            if (
                typeof obj.uuid === "string" &&
                (typeof obj.rule === "string" || typeof obj.title === "string")
            ) {
                count++;
            }
            for (const v of Object.values(obj)) walk(v);
        }
    };
    walk(resp.body);
    return count;
}

export default finishOnboardingSlo;
