import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KodusSession, RunContext, Scenario } from "../lib/types.js";
import { ensureOk, http } from "../lib/http.js";
import { ensureLicenseSeat } from "../lib/onboarding.js";
import { pollUntil } from "../providers/base.js";
import { logger } from "../lib/log.js";

const log = logger("kody-rules");

// Fixture branch pair per provider. Each fixture branch lives permanently in
// the test repo and contains a file with deliberate TODO_REMOVE_ME markers
// (both as a comment and as a string literal) so the rule we create at
// runtime always has something concrete to match against. We use
// `openPRFromBranches` instead of the old clone+push flow because:
//   - the old flow took ~70s per run on sentry (large repo)
//   - the fixture content is stable, so there's nothing per-run that needs
//     to be authored from the test runner
const FIXTURE_BRANCHES: Record<
    string,
    { head: string; base: string } | undefined
> = {
    github: {
        // Persistent fixture branch in kodus-e2e/tiny-url. Adds
        // `src/legacy/cleanup.ts` with TODO_REMOVE_ME both as a string
        // literal (FORBIDDEN_MARKER constant) and inside a comment, so a
        // rule forbidding the identifier matches either interpretation.
        head: "fixture/kody-rule-todo-remove-me",
        base: "main",
    },
    gitlab: {
        // Same fixture mirrored into gitlab.com/kodus-e2e/tiny-url. The
        // branch was pushed as part of the initial fixture seeding.
        head: "fixture/kody-rule-todo-remove-me",
        base: "main",
    },
    "azure-devops": {
        // Same fixture mirrored into Azure DevOps:
        // dev.azure.com/kodustech/kodus-e2e/_git/kodus-e2e.
        head: "fixture/kody-rule-todo-remove-me",
        base: "main",
    },
    bitbucket: {
        // Same fixture mirrored to bitbucket.org/kodustech/tiny-url.
        head: "fixture/kody-rule-todo-remove-me",
        base: "main",
    },
    // App-installed clone of tiny-url (kodus-e2e/tiny-url-app) carries
    // the same fixture/kody-rule-todo-remove-me branch via the
    // initial mirror; instance-scoped via GH_APP_TEST_REPO.
    "github-app": {
        head: "fixture/kody-rule-todo-remove-me",
        base: "main",
    },
};

export const kodyRulesCreateAndApply: Scenario = {
    id: "kody-rules-create-and-apply",
    title: "A Kody Rule is created and applied to a fresh PR",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github", "github-app", "gitlab", "bitbucket", "azure-devops"],
        license: ["paid", "license-paid"],
    },
    timeoutSec: 1200,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, "scenario requires a tenant");

        const fixture = FIXTURE_BRANCHES[ctx.provider.name];
        ctx.assert(
            fixture,
            `No fixture branch pair configured for provider ${ctx.provider.name} in kody-rules.ts`,
        );
        if (!ctx.provider.openPRFromBranches) {
            throw new Error(
                `Provider ${ctx.provider.name} does not implement openPRFromBranches yet`,
            );
        }

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        // Rule application runs inside the review pipeline; on licensed
        // self-hosted the PR author needs a seat or the review is skipped.
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        // Sweep stale `e2e-rule-*` rules from prior runs BEFORE creating a new
        // one. The per-run `finally` deletes the rule it created, but a crash /
        // SIGINT / failed delete leaks it — and these rules are IDENTICAL
        // "flag TODO_REMOVE_ME" rules. When N duplicates exist, the review
        // links the TODO violation to whichever duplicate the engine picked
        // (an OLDER uuid), so the scenario's exact-`ruleId` suggestion query
        // returns 0 even though the rule fired — exactly the gitlab failure on
        // 2026-06-04 (org had 23 accumulated e2e TODO rules; the suggestion
        // blamed a rule from a previous day). Cleaning first restores 1 rule :
        // 1 expected blame. Matches by the `e2e-rule-` title prefix so a
        // human's rule is never touched.
        const swept = await sweepStaleE2ERules(ctx, session, String(repo.id));
        if (swept > 0) {
            log.info(`[kody-rules] swept ${swept} stale e2e-rule-* rule(s) before creating a fresh one`);
        }

        const ruleName = `e2e-rule-${ctx.runId.slice(0, 8)}-${randomUUID().slice(0, 6)}`;
        // The rule must be unambiguous AND override intent-aware reasoning.
        // Prior wording said "Forbid any occurrence... including in comments
        // and string literals" — the fixture file declares itself as an
        // "intentional E2E fixture", and Kimi K2.6 then "helpfully" excuses
        // every match as deliberate test data, returning 0 findings. This
        // surfaced as github-only flake on 2026-05-23 (gitlab/azure passed
        // by luck on the same fixture). Reframe the rule as a mechanical
        // string check with explicit instructions to ignore comments,
        // fixtures, file purpose, and authorial intent — the LLM cannot
        // claim the marker is "intentional" when the rule itself names
        // fixture/test/intentional code as still-in-scope.
        const ruleInstruction =
            "Mechanical static-analysis check (no intent reasoning, no fixture exemption): flag EVERY occurrence of the substring `TODO_REMOVE_ME` anywhere in the diff — including identifiers, string literals, comments, fixture files, test code, legacy modules, and code the author explicitly marks as intentional. The presence of the substring is the violation. Do NOT skip an occurrence because the file claims to be a test fixture or because a comment says the marker is intentional.";

        const ruleResp = await http<{
            data?: { uuid?: string; id?: string };
        }>(
            // POST /kody-rules/create-or-update (CreateKodyRuleDto). `type`,
            // `title`, `rule`, `severity` are required by the DTO; severity is
            // lowercase. `origin` is optional (defaults to 'manual') and must be
            // one of the KodyRulesOrigin values: manual, library, past_reviews,
            // repo_file_sync, onboarding_repo_analysis, mcp_agent, cli.
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
        ensureOk(ruleResp, "kody-rules:create");
        const ruleId = ruleResp.body.data?.uuid ?? ruleResp.body.data?.id;
        ctx.assert(
            ruleId,
            "Rule was created but the response did not include uuid/id",
        );

        // The code-review pipeline only enforces ACTIVE rules, and a freshly
        // created rule isn't reliably loadable by ResolveConfigStage the
        // instant /create-or-update returns. Under matrix contention (4
        // self-hosted droplets sharing one LLM key) the PR's review can fire
        // before the rule propagates and then run the kody-rules agent with no
        // rule in context — observed on bitbucket (rules-agent input=47 tokens,
        // 0 suggestions) while github/gitlab/azure won the race the same run.
        // Poll until the rule is visible AND active for this org, then a short
        // settle for review-side config propagation, before opening the PR — so
        // the review deterministically sees the rule instead of racing it.
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
            `Rule ${ruleName} (${ruleId}) did not reach status=active within 60s of creation — the review would race it. Aborting before opening the PR.`,
        );
        // Small settle: the rule is active in the DB, but give the review's
        // per-repo config load a beat to observe it under load.
        await new Promise((r) => setTimeout(r, 5_000));

        const sinceIso = new Date().toISOString();
        const opened = await ctx.provider.openPRFromBranches({
            head: fixture!.head,
            base: fixture!.base,
            title: `[e2e] kody-rules ${ruleName}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId} to validate rule ${ruleName}. Auto-closed by the scenario; branches are persistent fixtures and are not deleted.`,
        });

        try {
            // One review→suggestions pass. Returns the review activity and
            // the count of suggestions the pipeline linked to OUR rule.
            //
            // Why a poll for suggestions instead of one-shot: pollForReview
            // returns as soon as Kody posts the completion comment on the
            // provider, but the pipeline persists
            // `files.suggestions[].brokenKodyRulesIds` asynchronously after
            // the comment is delivered. On bitbucket (individual API calls
            // ~1.3s each) the suggestion landed ~11s AFTER pollForReview
            // returned, so a one-shot read raced and saw 0. 60s is plenty.
            const collect = async (since: string) => {
                const review = await ctx.provider.pollForReview(
                    { number: opened.number },
                    { sinceIso: since, timeoutSec: 720 },
                );
                ctx.assert(
                    review.reviewComments +
                        review.issueComments +
                        review.reviews >
                        0,
                    `No review activity on PR ${opened.url} within timeout`,
                );
                const count =
                    (await pollUntil(async () => {
                        const resp = await http<{ data?: unknown[] }>(
                            `${ctx.target.apiBaseUrl}/kody-rules/suggestions?ruleId=${encodeURIComponent(ruleId!)}`,
                            {
                                headers: {
                                    Authorization: `Bearer ${session.accessToken}`,
                                },
                                timeoutMs: 30_000,
                            },
                        );
                        ensureOk(resp, "kody-rules:findSuggestionsByRule");
                        const c = Array.isArray(resp.body.data)
                            ? resp.body.data.length
                            : 0;
                        return c > 0 ? c : null;
                    }, { intervalSec: 3, timeoutSec: 60 })) ?? 0;
                return { review, count };
            };

            let { review, count: suggestionsCount } = await collect(sinceIso);

            // The rule influenced the review iff ≥1 suggestion links back to
            // it. A 0 here has TWO possible causes and we must distinguish
            // them deterministically:
            //   (a) propagation race — the review fired before the freshly
            //       created rule reached the worker's per-repo config, so the
            //       rules-agent ran with the rule ABSENT (observed on
            //       bitbucket, the slowest provider: rules-agent input ~47
            //       tokens, 0 suggestions, while github/gitlab/azure won the
            //       race the same run). The rule has been active for minutes
            //       by now, so re-triggering the review on the SAME PR gives
            //       a clean second pass that deterministically sees it.
            //   (b) real regression — the rule pipeline ignored an obvious
            //       match. If the re-trigger ALSO yields 0, it's (b) and we
            //       fail loudly.
            // Re-trigger only when the first review neither linked a
            // suggestion to our ruleId NOR visibly flagged the marker. If the
            // marker WAS flagged, the rule fired and the missing id-link is
            // just async suggestion persistence (observed: suggestion row
            // written ~80s after MR open) — re-triggering there is pointless
            // and, on an already-reviewed MR, often yields no new review at
            // all, which used to fail the scenario at the poll timeout.
            // One retry, not a loop: a true propagation race clears on the
            // second pass; anything that survives is a genuine bug.
            const firstReviewFlagged = (review.sample ?? "")
                .toLowerCase()
                .includes("todo_remove_me");
            if (suggestionsCount === 0 && !firstReviewFlagged) {
                log.warn(
                    `0 suggestions and no marker in the first review of PR ${opened.url} — re-triggering (rule propagation race vs real miss)`,
                );
                const retrigger = await ctx.provider.triggerReviewOnExistingPR(
                    opened.number,
                );
                ({ review, count: suggestionsCount } = await collect(
                    retrigger.sinceIso,
                ));
            }

            // The scenario proves "a created rule is APPLIED to a fresh PR".
            // Two independent signals confirm that; either suffices:
            //   1. suggestionsCount>0 — a suggestion links back to OUR ruleId
            //      (the strict signal; reliable now that sweepStaleE2ERules
            //      guarantees no duplicate rule can absorb the blame).
            //   2. the review visibly flagged the marker — the completion
            //      comment names our rule or the TODO_REMOVE_ME substring.
            // Relying on #1 alone made this brittle: when a duplicate rule
            // existed the engine attributed the finding to the OTHER uuid, so
            // the exact-id query returned 0 while the rule had plainly fired
            // (gitlab, 2026-06-04). #2 catches that case deterministically.
            const sampleText = (review.sample ?? "").toLowerCase();
            const reviewFlaggedMarker =
                sampleText.includes(ruleName.toLowerCase()) ||
                sampleText.includes("todo_remove_me");

            ctx.assert(
                suggestionsCount > 0 || reviewFlaggedMarker,
                `Rule ${ruleName} was not applied to PR ${opened.url}: 0 suggestions linked to its ruleId AND the review comment never flagged TODO_REMOVE_ME, even after a re-triggered review — the fixture branch contains explicit TODO_REMOVE_ME occurrences, so the rule pipeline ignored an active rule (real regression, not a propagation race). reviewSample(head)=${(review.sample ?? "").slice(0, 200)}`,
            );

            // Informational only — captured as evidence, not asserted on.
            // The sample text depends on LLM phrasing and is out of scope
            // for this mechanics test.
            const sample = (review.sample ?? "").toLowerCase();
            const mentionsRule =
                sample.includes(ruleName.toLowerCase()) ||
                sample.includes("todo_remove_me") ||
                sample.includes("kody rule") ||
                sample.includes("rule violation");

            writeFileSync(
                join(ctx.artifactDir, "review-sample.txt"),
                review.sample ?? "(no sample captured)",
            );

            return {
                ruleId,
                ruleName,
                pr: opened,
                review,
                suggestionsCount,
                rulementioned: mentionsRule,
            };
        } finally {
            try {
                await ctx.provider.closePR(opened);
            } catch (err) {
                /* best effort */
            }
            if (ruleId) {
                try {
                    await http(
                        // DELETE /kody-rules/delete-rule-in-organization-by-id
                        // ?ruleId=…&teamId=… (query params, not path).
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

// Recursively locate a rule's status by uuid in the
// /kody-rules/find-by-organization-id response. Shape is roughly
// `{ data: [{ repositoryId, rules: [{ uuid, status }] }] }`, but we walk it
// defensively so a response-shape tweak doesn't silently break the wait.
function findRuleStatusById(
    node: unknown,
    ruleId: string,
): string | undefined {
    if (Array.isArray(node)) {
        for (const item of node) {
            const s = findRuleStatusById(item, ruleId);
            if (s) return s;
        }
        return undefined;
    }
    if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (obj.uuid === ruleId && typeof obj.status === "string") {
            return obj.status;
        }
        for (const v of Object.values(obj)) {
            const s = findRuleStatusById(v, ruleId);
            if (s) return s;
        }
    }
    return undefined;
}

// Collect every {uuid, title} pair anywhere in the find-by-organization-id
// response (shape ≈ `{ data: [{ repositoryId, rules: [{ uuid, title, … }] }] }`,
// walked defensively). Used to find stale e2e rules to delete.
function collectRules(
    node: unknown,
    out: Array<{ uuid: string; title: string }>,
): void {
    if (Array.isArray(node)) {
        for (const item of node) collectRules(item, out);
        return;
    }
    if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (typeof obj.uuid === "string" && typeof obj.title === "string") {
            out.push({ uuid: obj.uuid, title: obj.title });
        }
        for (const v of Object.values(obj)) collectRules(v, out);
    }
}

// Delete every `e2e-rule-*` rule left over from prior runs (crashes skip the
// per-run finally). Best-effort — returns how many it deleted; a failed
// delete just logs and is retried next run. Title-prefix scoped so a human
// rule is never removed.
async function sweepStaleE2ERules(
    ctx: RunContext,
    session: KodusSession,
    _repoId: string,
): Promise<number> {
    const listResp = await http(
        `${ctx.target.apiBaseUrl}/kody-rules/find-by-organization-id`,
        {
            headers: { Authorization: `Bearer ${session.accessToken}` },
            timeoutMs: 15_000,
        },
    );
    const found: Array<{ uuid: string; title: string }> = [];
    collectRules(listResp.body, found);
    // De-dupe (the same rule can appear under multiple repo groupings).
    const stale = [
        ...new Map(
            found
                .filter((r) => /^e2e-rule-/.test(r.title))
                .map((r) => [r.uuid, r]),
        ).values(),
    ];
    let deleted = 0;
    for (const r of stale) {
        try {
            const del = await http(
                `${ctx.target.apiBaseUrl}/kody-rules/delete-rule-in-organization-by-id?ruleId=${encodeURIComponent(r.uuid)}&teamId=${encodeURIComponent(session.teamId)}`,
                {
                    method: "DELETE",
                    headers: { Authorization: `Bearer ${session.accessToken}` },
                    timeoutMs: 20_000,
                },
            );
            if (del.status >= 200 && del.status < 300) deleted++;
        } catch {
            /* best effort — next run sweeps it */
        }
    }
    return deleted;
}

export default kodyRulesCreateAndApply;
