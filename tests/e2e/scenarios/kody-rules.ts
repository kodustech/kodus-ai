import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunContext, Scenario } from "../lib/types.js";
import { ensureOk, http } from "../lib/http.js";
import { ensureLicenseSeat } from "../lib/onboarding.js";
import { pollUntil } from "../providers/base.js";

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
            // `title`, `rule`, `severity`, `origin` are required by the DTO;
            // severity is lowercase, origin must be 'user'|'library'|'generated'.
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
                    origin: "user",
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
            const review = await ctx.provider.pollForReview(
                { number: opened.number },
                { sinceIso, timeoutSec: 720 },
            );

            // Mechanics: review pipeline ran end-to-end and Kody finished
            // (status "Complete!" comment or real inline findings).
            ctx.assert(
                review.reviewComments + review.issueComments + review.reviews >
                    0,
                `No review activity on PR ${opened.url} within timeout`,
            );

            // Apply: the rule influenced the review. Mechanically observable
            // via Kodus's own API (`GET /kody-rules/suggestions?ruleId=…`)
            // which returns suggestions whose pipeline-side metadata links
            // them to this rule. We don't inspect the suggestion text — only
            // count — so we don't reintroduce LLM-quality flakiness. If 0
            // suggestions came back for an obvious fixture (literal +
            // commented TODO_REMOVE_ME against a rule explicitly forbidding
            // it), the rule pipeline silently skipped — a real regression.
            //
            // Why a poll instead of one-shot: pollForReview returns as soon
            // as Kody posts the completion comment on the provider, but the
            // pipeline persists `files.suggestions[].brokenKodyRulesIds`
            // asynchronously after the comment is delivered. On bitbucket
            // (where individual API calls are ~1.3s each) we observed the
            // suggestion landing ~11s AFTER pollForReview returned, so a
            // one-shot read raced and saw 0. 60s is plenty for any provider
            // — fast ones return on the first attempt anyway.
            const suggestionsCount = await pollUntil(async () => {
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
                const count = Array.isArray(resp.body.data)
                    ? resp.body.data.length
                    : 0;
                return count > 0 ? count : null;
            }, { intervalSec: 3, timeoutSec: 60 }) ?? 0;
            ctx.assert(
                suggestionsCount > 0,
                `Rule ${ruleName} produced 0 suggestions even though the fixture branch contains explicit TODO_REMOVE_ME occurrences. Either the rule pipeline didn't run for this PR or it ignored the rule.`,
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

export default kodyRulesCreateAndApply;
