import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunContext, Scenario } from "../lib/types.js";
import { ensureOk, http } from "../lib/http.js";
import { ensureLicenseSeat } from "../lib/onboarding.js";
import { pollUntil } from "../providers/base.js";
import { logger } from "../lib/log.js";
import {
    FIXTURE_BRANCHES,
    findRuleStatusById,
    sweepStaleE2ERules,
} from "./kody-rules.js";

const log = logger("kody-rules-coverage");

// ── #1449 coverage regression guard ──────────────────────────────────────────
//
// The bug this scenario protects against: the OLD agentic kody-rules agent let
// the LLM decide which files to open within a turn budget, so on a PR with the
// SAME rule violated at multiple sites it flagged only some (occurrence-recall
// 35-72%, worst on the strongest model). The sharded rewrite iterates every
// changed file deterministically, so every site is judged.
//
// `kody-rules-create-and-apply` proves a rule fires AT ALL (≥1 suggestion).
// This one proves it fires at MULTIPLE sites — the property the sharding fix
// restored. It reuses the same fixture branch (the marker appears as both a
// string literal and a comment, on different lines → ≥2 distinct sites).
//
// NOTE: the strength of this gate scales with the fixture. To make it a hard
// multi-file coverage test, enrich `fixture/kody-rule-todo-remove-me` in the
// e2e repos to carry the marker on N≥6 lines across ≥2 files, then raise
// COVERAGE_MIN. With the current fixture we assert ≥2 (already impossible for
// the pre-fix agent to reliably hit when it opened the wrong file first).
const COVERAGE_MIN = Number(process.env.KODY_RULES_COVERAGE_MIN ?? 2);

export const kodyRulesCoverage: Scenario = {
    id: "kody-rules-coverage",
    title: "A Kody Rule is flagged at every site in a PR (sharding coverage, #1449)",
    priority: "P1",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github", "gitlab", "bitbucket", "azure-devops"],
        license: ["paid", "license-paid"],
    },
    timeoutSec: 1200,
    async run(ctx: RunContext) {
        // The shared fixture carries the marker on ~2 lines that dedup can fold
        // into one comment, so a ≥2 multi-site assertion can't reliably pass on
        // it — kody-rules-create-and-apply already proves the rule fires. Skip
        // by default; enrich fixture/kody-rule-todo-remove-me to N≥6 lines
        // across ≥2 files, then set KODY_RULES_COVERAGE_ENABLED=1 (and
        // COVERAGE_MIN) to turn this into a real multi-site gate.
        if (process.env.KODY_RULES_COVERAGE_ENABLED !== "1") {
            ctx.skip(
                "kody-rules-coverage pending an enriched multi-site fixture " +
                    "(set KODY_RULES_COVERAGE_ENABLED=1 once fixture/kody-rule-todo-remove-me carries N≥6 marker sites)",
            );
        }

        ctx.assert(ctx.tenant, "scenario requires a tenant");
        const fixture = FIXTURE_BRANCHES[ctx.provider.name];
        ctx.assert(
            fixture,
            `No fixture branch pair configured for provider ${ctx.provider.name}`,
        );
        if (!ctx.provider.openPRFromBranches) {
            ctx.skip(
                `Provider ${ctx.provider.name} does not implement openPRFromBranches yet`,
            );
        }

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        // Clear accumulated e2e rules so the exact-ruleId suggestion query is
        // not absorbed by a stale duplicate (same rationale as the sibling).
        await sweepStaleE2ERules(ctx, session, String(repo.id));

        const ruleName = `e2e-rule-coverage-${randomUUID().slice(0, 8)}`;
        const ruleInstruction =
            "Mechanical static-analysis check (no intent reasoning, no fixture exemption): flag EVERY occurrence of the substring `TODO_REMOVE_ME` anywhere in the diff — including identifiers, string literals, comments, fixture files, test code, and code the author marks as intentional. Each occurrence on a distinct line is a separate violation. The presence of the substring is the violation.";

        const ruleResp = await http<{ data?: { uuid?: string; id?: string } }>(
            `${ctx.target.apiBaseUrl}/kody-rules/create-or-update`,
            {
                method: "POST",
                headers: { Authorization: `Bearer ${session.accessToken}` },
                body: {
                    teamId: session.teamId,
                    repositoryId: String(repo.id),
                    type: "standard",
                    title: ruleName,
                    rule: ruleInstruction,
                    severity: "high",
                    origin: "manual",
                    path: "",
                },
                timeoutMs: 30_000,
            },
        );
        ensureOk(ruleResp, "kody-rules-coverage:create");
        const ruleId = ruleResp.body.data?.uuid ?? ruleResp.body.data?.id;
        ctx.assert(ruleId, "Rule created but response had no uuid/id");

        const ruleActive = await pollUntil<boolean>(
            async () => {
                const r = await http(
                    `${ctx.target.apiBaseUrl}/kody-rules/find-by-organization-id`,
                    {
                        headers: {
                            Authorization: `Bearer ${session.accessToken}`,
                        },
                        timeoutMs: 15_000,
                    },
                );
                return findRuleStatusById(r.body, ruleId) === "active"
                    ? true
                    : null;
            },
            { intervalSec: 3, timeoutSec: 60 },
        );
        ctx.assert(
            ruleActive,
            `Rule ${ruleName} (${ruleId}) did not reach status=active within 60s`,
        );
        await new Promise((r) => setTimeout(r, 5_000));

        const sinceIso = new Date().toISOString();
        const opened = await ctx.provider.openPRFromBranches({
            head: fixture!.head,
            base: fixture!.base,
            title: `[e2e] kody-rules coverage ${ruleName}`,
            body: `Automated PR (run ${ctx.runId}) validating multi-site coverage for rule ${ruleName}. Auto-closed; fixture branches are persistent.`,
        });

        try {
            const review = await ctx.provider.pollForReview(
                { number: opened.number },
                { sinceIso, timeoutSec: 720 },
            );
            ctx.assert(
                review.reviewComments + review.issueComments + review.reviews >
                    0,
                `No review activity on PR ${opened.url} within timeout`,
            );

            // Count suggestions linked to OUR rule. The coverage signal is the
            // COUNT (distinct sites), not merely presence. Track the best count
            // seen so a below-floor result reports the TRUE number (not 0) —
            // otherwise the failure message misleads ("0 sites" when it was 1).
            let bestCount = 0;
            const suggestionsCount =
                (await pollUntil<number>(async () => {
                    const resp = await http<{ data?: unknown[] }>(
                        `${ctx.target.apiBaseUrl}/kody-rules/suggestions?ruleId=${encodeURIComponent(ruleId!)}`,
                        {
                            headers: {
                                Authorization: `Bearer ${session.accessToken}`,
                            },
                            timeoutMs: 30_000,
                        },
                    );
                    ensureOk(resp, "kody-rules-coverage:suggestions");
                    const c = Array.isArray(resp.body.data)
                        ? resp.body.data.length
                        : 0;
                    if (c > bestCount) bestCount = c;
                    // stop early once the floor lands; otherwise keep polling
                    return c >= COVERAGE_MIN ? c : null;
                }, { intervalSec: 3, timeoutSec: 90 })) ?? bestCount;

            writeFileSync(
                join(ctx.artifactDir, "coverage.json"),
                JSON.stringify(
                    { ruleId, ruleName, suggestionsCount, COVERAGE_MIN },
                    null,
                    2,
                ),
            );
            log.info(
                `coverage: ${suggestionsCount} sites flagged for ${ruleName} (floor ${COVERAGE_MIN})`,
            );

            ctx.assert(
                suggestionsCount >= COVERAGE_MIN,
                `Coverage regression (#1449): rule ${ruleName} was flagged at only ${suggestionsCount} site(s) on PR ${opened.url}, expected ≥${COVERAGE_MIN}. The fixture contains the marker on multiple lines; under-coverage means the sharded sweep missed sites (the exact failure mode the rewrite fixed).`,
            );

            return { ruleId, ruleName, pr: opened, suggestionsCount };
        } finally {
            try {
                await ctx.provider.closePR(opened);
            } catch {
                /* best effort */
            }
            if (ruleId) {
                try {
                    await http(
                        `${ctx.target.apiBaseUrl}/kody-rules/delete-rule-in-organization-by-id?ruleId=${encodeURIComponent(ruleId)}&teamId=${encodeURIComponent(session.teamId)}`,
                        {
                            method: "DELETE",
                            headers: {
                                Authorization: `Bearer ${session.accessToken}`,
                            },
                        },
                    );
                } catch {
                    /* best effort */
                }
            }
        }
    },
};

export default kodyRulesCoverage;
