import { randomUUID } from 'node:crypto';
import { ensureLicenseSeat } from '../lib/onboarding.js';
import {
    assertHealthyExecution,
    assertPersistedSuggestions,
    waitForNthTerminalExecution,
} from '../lib/execution-health.js';
import type { RunContext, Scenario } from '../lib/types.js';
import { extractSuggestedCode } from './review-decision-memory.js';

// Negative-control counterpart to review-decision-memory.ts. That scenario
// proves memory doesn't cause FALSE reversals (Kody undoing a fix that's
// still good). This one proves the opposite failure mode isn't happening
// either: memory must not cause OVER-SUPPRESSION of a re-flag that's
// genuinely warranted because the fix was actually undone.
//
// Modeled on a GENUINE, ground-truth-confirmed production incident found
// during this investigation (internal dogfooding data, Sept 2026): round A
// flagged a bug in a deploy step (a secret fetch whose failure was silently
// swallowed); the developer applied the fix; a following commit reverted
// that exact fix back to the original buggy pattern; round B correctly
// re-flagged it despite a PreviousReviewDecision marking the issue
// "implemented". This scenario reproduces that exact 3-step shape for real
// (with a generic fixture, not naming any internal system): introduce the
// bug, apply Kody's own real suggested fix, then deliberately revert it, and
// assert round 3 still flags it.
const FIXTURE_PATH = 'src/e2e-decision-memory-revert-fixture.ts';

const BUGGY_CONTENT = `export function parseConfigValue(raw: string | null): number {
    return parseInt(raw, 10);
}
`;

export const reviewDecisionMemoryRevert: Scenario = {
    id: 'review-decision-memory-revert',
    title:
        "Kody still flags a genuinely reverted fix despite PreviousReviewDecisions marking it 'implemented' — #1313 anti-over-suppression negative control",
    priority: 'P1',
    appliesTo: {
        target: ['cloud', 'self-hosted'],
        provider: ['github'],
        license: ['paid', 'license-paid'],
    },
    // Three real review rounds (bug -> fix -> revert), each budgeted like
    // review-decision-memory.ts's own rounds, plus onboarding/push overhead.
    timeoutSec: 4800,
    async run(ctx: RunContext) {
        ctx.assert(
            ctx.tenant,
            'scenario requires a tenant (set CLOUD_TENANT_*_EMAIL or SH_TENANT_EMAIL)',
        );
        ctx.assert(
            ctx.provider.pushFollowupCommit && ctx.provider.listReviewCommentBodies,
            `Provider ${ctx.provider.name} does not implement pushFollowupCommit/listReviewCommentBodies yet — required for this scenario's 3 review rounds`,
        );

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        const branch = `e2e/decision-memory-revert-${ctx.runId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
        const sinceIsoRound1 = new Date().toISOString();
        const pr = await ctx.provider.openPR({
            branch,
            baseBranch: 'main',
            title: `[e2e] review-decision-memory-revert ${ctx.runId.slice(0, 8)}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId}. Introduces a deliberate bug, applies Kody's real fix, then deliberately REVERTS that fix and checks round 3 still flags it despite the earlier 'implemented' decision.`,
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
                    ? `Round 1 pipeline started (heartbeat at ${pipelineStartedAt}) but produced 0 findings on PR #${pr.number}. The fixture (${FIXTURE_PATH}) parses an argument typed as nullable without guarding it — any decent LLM should flag it.`
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

            // ---- Extract Kody's REAL suggestion and apply it verbatim.
            // This is the fix whose eventual, genuine reversal round 3 must
            // still catch. ----
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

            // ---- Round 2: apply the fix for real ----
            const sinceIsoRound2 = new Date().toISOString();
            await ctx.provider.pushFollowupCommit!(
                pr,
                { [FIXTURE_PATH]: suggestedFix! },
                "[e2e] apply Kody's suggested fix verbatim",
            );

            const executionsAfterRound2 = await waitForNthTerminalExecution(
                ctx,
                session,
                pr.number,
                2,
                1500,
            );
            ctx.assert(
                executionsAfterRound2 !== null,
                `Pushing the fix to PR #${pr.number} never produced a 2nd automation execution row that reached a terminal status within 1500s.`,
            );
            // Let the comment-delivery side catch up, mirroring
            // review-decision-memory.ts's own settle gap.
            await new Promise((resolve) => setTimeout(resolve, 5_000));

            // ---- Round 3: REVERT the fix back to the original buggy
            // content — the deliberate negative-control step. Nothing about
            // this commit is "new"; it is byte-for-byte the same content
            // round 1 already saw and got fixed. A PreviousReviewDecision
            // for this file will say "implemented" going into this round;
            // the only thing that should stop Kody from suppressing the
            // re-flag is the diff itself showing the fix was undone. ----
            const sinceIsoRound3 = new Date().toISOString();
            await ctx.provider.pushFollowupCommit!(
                pr,
                { [FIXTURE_PATH]: BUGGY_CONTENT },
                '[e2e] revert the applied fix back to the original buggy content',
            );

            const executionsAfterRound3 = await waitForNthTerminalExecution(
                ctx,
                session,
                pr.number,
                3,
                1500,
            );
            ctx.assert(
                executionsAfterRound3 !== null,
                `Reverting the fix on PR #${pr.number} never produced a 3rd automation execution row that reached a terminal status within 1500s.`,
            );
            await new Promise((resolve) => setTimeout(resolve, 5_000));

            const round3Bodies = await ctx.provider.listReviewCommentBodies!(
                { number: pr.number },
                { sinceIso: sinceIsoRound3, path: FIXTURE_PATH },
            );
            ctx.assert(
                round3Bodies.length > 0,
                `Round 3 posted 0 comment(s) on ${FIXTURE_PATH} after the fix was deliberately reverted ` +
                    `back to the exact original buggy content — the PreviousReviewDecision marking this ` +
                    `issue 'implemented' appears to have suppressed a re-flag that concrete diff evidence ` +
                    `(the applied change being undone) should have overridden. This is the #1313 ` +
                    `OVER-SUPPRESSION symptom (the inverse failure mode from the main scenario).`,
            );

            return {
                prNumber: pr.number,
                prUrl: pr.url,
                round1: {
                    executionStatus: executionStatusRound1,
                    persistedSuggestions: persistedRound1,
                    reviewSignal: round1,
                },
                round2: { executions: executionsAfterRound2 },
                round3: {
                    executions: executionsAfterRound3,
                    commentsOnRevertedFile: round3Bodies.length,
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

export default reviewDecisionMemoryRevert;
