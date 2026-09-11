import { randomUUID } from 'node:crypto';
import { ensureLicenseSeat } from '../lib/onboarding.js';
import {
    assertHealthyExecution,
    assertPersistedSuggestions,
    countExecutions,
} from '../lib/execution-health.js';
import { http, ensureOk } from '../lib/http.js';
import { pollUntil } from '../providers/base.js';
import type { RunContext, Scenario } from '../lib/types.js';

// A throwaway file this scenario owns end to end — never touches any
// shared/persistent fixture branch (e.g. code-review-basic's
// bug/missing-null-check, which other scenarios also depend on staying
// buggy). Because the file doesn't exist on `main` at all, it stays in the
// PR's diff for round 2 no matter what content round 2 writes — no risk of
// the "fix" accidentally converging back to base and dropping the file out
// of `changedFiles` (which would make the assertion pass for the wrong
// reason: nothing left to review, not "the memory worked").
const FIXTURE_PATH = 'src/e2e-decision-memory-fixture.ts';

const BUGGY_CONTENT = `export function getUserName(user: { name: string } | null): string {
    return user.name;
}
`;

// The deterministic, "correct" fix — hardcoded here, NOT derived from
// whatever Kody's actual round-1 suggestion said. Round 1 only needs to
// prove Kody flagged *something* on this file (assert findings > 0); round
// 2 is judged against this fixed reference, not against Kody's own words,
// so the scenario can't be gamed by an LLM that reworded the fix.
const FIXED_CONTENT = `export function getUserName(user: { name: string } | null): string {
    if (!user) {
        return '';
    }
    return user.name;
}
`;

// A round-2 comment on this file matching any of these means Kody suggested
// UNDOING the applied fix — the exact #1313 symptom (contradicting a
// decision already applied in an earlier round). Deliberately narrow: this
// is a heuristic over real markdown comment bodies, not an LLM judge, so it
// only needs to catch the specific reversal this fixture provokes, not every
// way a model could phrase disagreement.
const CONTRADICTION_PATTERNS = [
    /remov(e|ing|ed)\s+(the\s+)?(null|undefined)?[\s-]*check/i,
    // Both word orders: "unnecessary null check" AND "check ... is unnecessary".
    /unnecessary.{0,30}(null|undefined)?[\s-]*check\b/i,
    /\bcheck\b.{0,30}unnecessary/i,
    /simplify.{0,40}(remov|delet|drop)/i,
    /return\s+user\.name\s+directly/i,
];

/** Exported for unit testing (lib/__tests__/review-decision-memory.test.ts) —
 *  same reasoning as classifyKodyComment: this regex heuristic decides a
 *  live assertion, so it needs coverage independent of a real E2E run. */
export function isContradictionComment(body: string): boolean {
    return CONTRADICTION_PATTERNS.some((re) => re.test(body));
}

export const reviewDecisionMemory: Scenario = {
    id: 'review-decision-memory',
    title:
        "Kody doesn't contradict a decision already applied in an earlier review round (#1313)",
    priority: 'P1',
    // github-only for now: pushFollowupCommit/listReviewCommentBodies are
    // only implemented on the GitHub provider (see tests/e2e/lib/git.ts
    // and providers/github.ts). Extend appliesTo once the other providers
    // grow the same two capabilities.
    appliesTo: {
        target: ['cloud', 'self-hosted'],
        provider: ['github'],
        license: ['paid', 'license-paid'],
    },
    // Two real review rounds, each budgeted like code-review-basic's
    // pollForReview (1500s), plus onboarding + push overhead.
    timeoutSec: 3300,
    async run(ctx: RunContext) {
        ctx.assert(
            ctx.tenant,
            'scenario requires a tenant (set CLOUD_TENANT_*_EMAIL or SH_TENANT_EMAIL)',
        );
        ctx.assert(
            ctx.provider.pushFollowupCommit && ctx.provider.listReviewCommentBodies,
            `Provider ${ctx.provider.name} does not implement pushFollowupCommit/listReviewCommentBodies yet — required for this scenario's 2nd review round`,
        );

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        const branch = `e2e/decision-memory-${ctx.runId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
        const sinceIsoRound1 = new Date().toISOString();
        const pr = await ctx.provider.openPR({
            branch,
            baseBranch: 'main',
            title: `[e2e] review-decision-memory ${ctx.runId.slice(0, 8)}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId}. Introduces a deliberate missing-null-check bug in a throwaway fixture file, then applies the fix for real and re-reviews.`,
            fixtureFiles: { [FIXTURE_PATH]: BUGGY_CONTENT },
        });

        try {
            // ---- Round 1: Kody must flag the deliberate bug ----
            let pipelineStartedAt: string | undefined;
            if (ctx.provider.waitForPipelineStart) {
                const started = await ctx.provider.waitForPipelineStart(
                    { number: pr.number },
                    { sinceIso: sinceIsoRound1, timeoutSec: 600 },
                );
                pipelineStartedAt = started.startedAt;
            }

            const round1 = await ctx.provider.pollForReview(
                { number: pr.number },
                { sinceIso: sinceIsoRound1, timeoutSec: 1500 },
            );
            ctx.assert(
                round1.reviewComments + round1.issueComments + round1.reviews > 0,
                pipelineStartedAt
                    ? `Round 1 pipeline started (heartbeat at ${pipelineStartedAt}) but produced 0 findings on PR #${pr.number}. The fixture (${FIXTURE_PATH}) has a deliberate missing-null-check bug — any decent LLM should flag it.`
                    : `No round-1 review findings on PR #${pr.number} within timeout.`,
            );

            const executionStatusRound1 = await assertHealthyExecution(
                ctx,
                session,
                pr.number,
            );
            const persistedRound1 = await assertPersistedSuggestions(
                ctx,
                session,
                pr.number,
            );

            // ---- Apply the fix for real, push a genuine 2nd commit ----
            const sinceIsoRound2 = new Date().toISOString();
            await ctx.provider.pushFollowupCommit!(
                pr,
                { [FIXTURE_PATH]: FIXED_CONTENT },
                '[e2e] apply the suggested null-check fix',
            );

            // ---- Round 2: wait for a SECOND execution row, not just any settle ----
            const executionsAfterRound2 = await pollUntil<number>(
                async () => {
                    const resp = await http<any>(
                        `${ctx.target.apiBaseUrl}/pull-requests/executions?pullRequestNumber=${pr.number}&teamId=${encodeURIComponent(session.teamId)}&limit=10`,
                        {
                            headers: {
                                Authorization: `Bearer ${session.accessToken}`,
                            },
                            timeoutMs: 30_000,
                        },
                    );
                    ensureOk(resp, 'executions:list:round2');
                    const count = countExecutions(resp.body, pr.number);
                    return count >= 2 ? count : null;
                },
                { intervalSec: 10, timeoutSec: 1500 },
            );
            ctx.assert(
                executionsAfterRound2 !== null,
                `Pushing a real follow-up commit to PR #${pr.number} never produced a 2nd automation execution row within 1500s — the review pipeline may not have re-triggered on the new commit.`,
            );

            const round2Bodies = await ctx.provider.listReviewCommentBodies!(
                { number: pr.number },
                { sinceIso: sinceIsoRound2, path: FIXTURE_PATH },
            );

            const contradictions = round2Bodies.filter(isContradictionComment);
            ctx.assert(
                contradictions.length === 0,
                `Round 2 posted ${contradictions.length} comment(s) on ${FIXTURE_PATH} that ` +
                    `suggest UNDOING the null-check fix already applied in round 1 — this is the ` +
                    `#1313 symptom (Kody contradicting a decision from an earlier review round). ` +
                    `Offending comment(s):\n${contradictions.map((c) => `---\n${c.slice(0, 500)}`).join('\n')}`,
            );

            return {
                prNumber: pr.number,
                prUrl: pr.url,
                round1: {
                    executionStatus: executionStatusRound1,
                    persistedSuggestions: persistedRound1,
                    reviewSignal: round1,
                },
                round2: {
                    executions: executionsAfterRound2,
                    commentsOnFixtureFile: round2Bodies.length,
                    contradictions: contradictions.length,
                },
            };
        } finally {
            try {
                await ctx.provider.closePR(pr);
            } catch {
                // best-effort cleanup — leaving the PR open is recoverable
            }
        }
    },
};

export default reviewDecisionMemory;
