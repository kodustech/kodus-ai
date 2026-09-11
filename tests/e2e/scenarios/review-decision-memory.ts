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

// A SECOND, unrelated throwaway file introduced in the SAME round-2 commit
// as the applied fix (see below). Its only purpose is a quality-regression
// guard: PreviousReviewDecisions in the prompt must only suppress
// contradicting the ALREADY-decided fixture, never suppress a genuinely new,
// unrelated finding elsewhere in the same diff. Same bug shape as
// BUGGY_CONTENT (missing null-check) because that shape has proven reliable
// across every real run of this scenario so far — a different function,
// unrelated to the fixture's decision history, so the check isolates
// "does memory over-suppress new findings" from anything decision-specific.
const QUALITY_CHECK_PATH = 'src/e2e-decision-memory-quality-check.ts';

const QUALITY_CHECK_BUGGY_CONTENT = `export function getFirstChar(text: string | null): string {
    return text.charAt(0);
}
`;

// Kody's suggestion comments render the replacement as the FIRST fenced
// code block in the body (a second, redundant one lives inside the
// "Prompt for LLM" <details> section further down) — e.g.:
//   ```undefined
//   export function getUserName(user: { name: string } | null): string {
//       return user ? user.name : '';
//   }
//   ```
//   <details><summary>Prompt for LLM</summary> ... </details>
// Matching greedily-but-non-greedy up to the FIRST closing fence lands on
// that first block and never the <details> copy.
const CODE_BLOCK_PATTERN = /```[^\n]*\n([\s\S]*?)```/;

/** Exported for unit testing. Extracts the code Kody actually suggested
 *  from a round-1 comment body, so the "developer applies it" step in this
 *  scenario applies the REAL suggestion — not an equivalent fix we wrote
 *  ourselves — matching how a developer actually uses Kody in practice. */
export function extractSuggestedCode(body: string): string | null {
    const match = body.match(CODE_BLOCK_PATTERN);
    if (!match) return null;
    const code = match[1].trim();
    return code.length > 0 ? `${code}\n` : null;
}

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

            // ---- Extract Kody's REAL suggestion and apply it verbatim ----
            const round1Bodies = await ctx.provider.listReviewCommentBodies!(
                { number: pr.number },
                { sinceIso: sinceIsoRound1, path: FIXTURE_PATH },
            );
            const suggestedFix = round1Bodies
                .map(extractSuggestedCode)
                .find((code): code is string => code !== null);
            ctx.assert(
                suggestedFix !== undefined,
                `Round 1 flagged the bug on ${FIXTURE_PATH} but none of its ${round1Bodies.length} ` +
                    `comment(s) contained a parseable suggested-code block — can't apply a real fix. ` +
                    `Comment(s):\n${round1Bodies.map((c) => `---\n${c.slice(0, 500)}`).join('\n')}`,
            );

            // ---- Apply the fix for real, push a genuine 2nd commit.
            // Bundles a second, unrelated buggy file in with the fix — see
            // QUALITY_CHECK_PATH's comment above for why. ----
            const sinceIsoRound2 = new Date().toISOString();
            await ctx.provider.pushFollowupCommit!(
                pr,
                {
                    [FIXTURE_PATH]: suggestedFix!,
                    [QUALITY_CHECK_PATH]: QUALITY_CHECK_BUGGY_CONTENT,
                },
                '[e2e] apply Kody\'s suggested fix verbatim + introduce an unrelated bug',
            );

            // ---- Round 2: wait for a SECOND execution row that has actually
            // FINISHED, not just appeared. `countExecutions` counts a row the
            // instant it exists — including `pending`/`in_progress` — so
            // `count >= 2` alone goes green while round 2's agent is still
            // mid-run, and every read taken right after (comments, contradiction
            // check, the quality-check assertion below) would be reading STALE
            // round-1 state or a still-empty round 2. `findExecutionStatus` is
            // documented to be no better here: "success anywhere wins" means it
            // would report round 1's success even with round 2 still in flight.
            // Read the newest row directly and require ITS status to be
            // terminal (API returns newest-first, confirmed against this same
            // endpoint throughout this session's manual verification). ----
            const TERMINAL_STATUSES = new Set([
                'success',
                'error',
                'partial_error',
                'skipped',
            ]);
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
                    if (count < 2) return null;
                    const entries: Array<{
                        automationExecution?: { status?: string };
                    }> = resp.body?.data?.data ?? [];
                    const latestStatus = entries[0]?.automationExecution?.status;
                    if (!latestStatus || !TERMINAL_STATUSES.has(latestStatus)) {
                        return null;
                    }
                    return count;
                },
                { intervalSec: 10, timeoutSec: 1500 },
            );
            ctx.assert(
                executionsAfterRound2 !== null,
                `Pushing a real follow-up commit to PR #${pr.number} never produced a 2nd automation execution row that reached a terminal status within 1500s — the review pipeline may not have re-triggered on the new commit, or is stuck in_progress.`,
            );
            // Let the comment-delivery side catch up to the now-terminal
            // execution — mirrors assertHealthyExecution's own settle gap.
            await new Promise((resolve) => setTimeout(resolve, 5_000));

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

            // ---- Quality-regression guard: memory must not suppress a
            // genuinely new, unrelated finding bundled into the same commit ----
            const qualityCheckBodies = await ctx.provider.listReviewCommentBodies!(
                { number: pr.number },
                { sinceIso: sinceIsoRound2, path: QUALITY_CHECK_PATH },
            );
            ctx.assert(
                qualityCheckBodies.length > 0,
                `Round 2 found 0 comment(s) on ${QUALITY_CHECK_PATH}, a brand-new deliberate ` +
                    `missing-null-check bug bundled into the SAME commit as the fix — this file has ` +
                    `no prior decision history, so PreviousReviewDecisions context must not have ` +
                    `suppressed it. Any decent LLM should flag it independent of memory; 0 findings ` +
                    `means the memory feature is over-suppressing unrelated new findings.`,
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
                    commentsOnQualityCheckFile: qualityCheckBodies.length,
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
