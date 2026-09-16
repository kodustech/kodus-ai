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
    // Gated on a directive cue ("you should/could/can", "please", "consider")
    // so a comment that merely DESCRIBES the already-applied fix in passing
    // (e.g. "removing the null check fixed the crash") isn't misread as a
    // suggestion to undo it — only an actual ask to remove it counts.
    /\b(you (should|could|can)|please|consider)\b.{0,40}remov(e|ing|ed)\s+(the\s+)?(null|undefined)?[\s-]*check/i,
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

// Second real bug shape, modeled on a GENUINE, ground-truth-confirmed #1313
// contradiction found during this investigation (internal dogfooding data,
// Sept 2026): round N fixed a resource-teardown-before-acquire ordering bug
// by moving the teardown to run AFTER the new resource exists; round N+1
// asked to move it back, reproducing the exact original lockout. Written
// fresh here as a generic, self-contained analog, not copied from the real
// incident's actual code or naming any internal system — same tension
// (teardown-before-vs-after-acquire on failure), different domain (token
// rotation).
const ORDERING_FIXTURE_PATH = 'src/e2e-decision-memory-ordering-fixture.ts';

// Bug: revokes the previous token before the new one is confirmed issued. If
// `issue()` throws, the caller is left with NO valid token at all — the
// previous one is already gone and the new one never arrived. The fix Kody
// should suggest is to issue first and only revoke the old one once the new
// one exists.
const ORDERING_BUGGY_CONTENT = `export async function rotateApiToken(
    store: { issue: () => Promise<string>; revoke: (token: string) => Promise<void> },
    previousToken: string | null,
): Promise<string> {
    if (previousToken) {
        await store.revoke(previousToken);
    }
    return store.issue();
}
`;

// A round-2 comment on this file matching any of these means Kody suggested
// moving the revoke back to run BEFORE issue — reversing the exact fix it
// (or the developer, applying its suggestion) put in place, reproducing the
// self-inflicted-lockout bug the fix exists to prevent.
const ORDERING_CONTRADICTION_PATTERNS = [
    /\b(you (should|could|can)|please|consider)\b.{0,60}revoke.{0,40}\bbefore\b.{0,20}issu/i,
    /\brevoke\b.{0,40}\bfirst\b/i,
    /\bmove\b.{0,40}revoke.{0,40}\b(before|above)\b/i,
    /\bissu\w*\b.{0,40}\bafter\b.{0,40}revok/i,
];

/** Exported for unit testing — the ordering-fixture counterpart of
 *  `isContradictionComment`. */
export function isOrderingContradictionComment(body: string): boolean {
    return ORDERING_CONTRADICTION_PATTERNS.some((re) => re.test(body));
}

// Third real bug shape, modeled on a GENUINE, ground-truth-confirmed #1313
// contradiction found in the same investigation: round N added a cap to stop
// an unbounded per-item loop from fanning out into hundreds of concurrent
// calls; round N+1 asked to remove the cap because it silently drops items
// past the limit — reproducing the exact fan-out the cap exists to prevent.
// Written fresh here as a generic analog (job-status polling), not naming
// any internal system.
const CAP_FIXTURE_PATH = 'src/e2e-decision-memory-cap-fixture.ts';

// Bug: no cap on `jobIds`, so a caller passing a large list makes this fan
// out into one `getStatus` call per id with no bound. The fix Kody should
// suggest is capping `jobIds` before the loop.
const CAP_BUGGY_CONTENT = `export async function fetchJobStatuses(
    api: { getStatus: (id: string) => Promise<string> },
    jobIds: string[],
): Promise<Record<string, string>> {
    const statuses: Record<string, string> = {};
    for (const id of jobIds) {
        statuses[id] = await api.getStatus(id);
    }
    return statuses;
}
`;

// A round-2 comment matching any of these means Kody suggested removing the
// cap entirely — reversing the exact fan-out fix it (or the developer,
// applying its suggestion) just put in place.
const CAP_CONTRADICTION_PATTERNS = [
    /\b(you (should|could|can)|please|consider)\b.{0,60}remov(e|ing)\s+(the\s+)?(cap|limit)\b/i,
    /\bremov(e|ing)\b.{0,30}\b(the\s+)?(cap|limit)\b/i,
    /\bwithout\s+(a\s+)?(cap|limit)\b/i,
    /\bno\s+(cap|limit)\b/i,
    /\bdrop(ping)?\s+the\s+(cap|limit)\b/i,
];

/** Exported for unit testing — the cap-fixture counterpart of
 *  `isContradictionComment`. */
export function isCapContradictionComment(body: string): boolean {
    return CAP_CONTRADICTION_PATTERNS.some((re) => re.test(body));
}

// Fourth real bug shape, modeled on a GENUINE, ground-truth-confirmed #1313
// regression found in the same investigation: a cache-key fallback that must
// be unique per tenant instead fell back to a value shared by every tenant
// on the same region+plan, reintroducing the exact collision the key exists
// to prevent. Written fresh here as a generic analog, not naming any
// internal system.
const COLLISION_FIXTURE_PATH = 'src/e2e-decision-memory-collision-fixture.ts';

// Bug: when `tenantId` is absent, the fallback seed is `region:plan` alone —
// identical for every tenant sharing that combination, so their cache
// entries collide. The fix Kody should suggest is keeping the fallback
// unique per tenant (e.g. mixing in something tenant-scoped, or requiring
// tenantId).
const COLLISION_BUGGY_CONTENT = `export function cacheKeyFor(cfg: {
    tenantId?: string;
    region: string;
    plan: string;
}): string {
    const seed = cfg.tenantId ? cfg.tenantId : \`\${cfg.region}:\${cfg.plan}\`;
    return seed;
}
`;

// A round-2 comment matching any of these means Kody suggested reverting to
// the shared, non-unique fallback — reintroducing the exact cross-tenant
// collision the fix exists to prevent.
const COLLISION_CONTRADICTION_PATTERNS = [
    /\b(you (should|could|can)|please|consider)\b.{0,60}(revert|remov(e|ing)|simplify|drop)\b.{0,60}(fallback|unique|tenant)/i,
    /\bjust\s+use\b.{0,40}\bregion\b.{0,20}\bplan\b/i,
    /\brevert\b.{0,40}\bfallback\b/i,
    /\bunnecessary\b.{0,40}\b(complexity|uniqueness)\b/i,
];

/** Exported for unit testing — the collision-fixture counterpart of
 *  `isContradictionComment`. */
export function isCollisionContradictionComment(body: string): boolean {
    return COLLISION_CONTRADICTION_PATTERNS.some((re) => re.test(body));
}

interface DecisionFixture {
    /** Human-readable label used only in assertion failure messages. */
    label: string;
    path: string;
    buggyContent: string;
    isContradiction: (body: string) => boolean;
}

const DECISION_FIXTURES: DecisionFixture[] = [
    {
        label: 'missing-null-check',
        path: FIXTURE_PATH,
        buggyContent: BUGGY_CONTENT,
        isContradiction: isContradictionComment,
    },
    {
        label: 'revoke-before-issue-ordering',
        path: ORDERING_FIXTURE_PATH,
        buggyContent: ORDERING_BUGGY_CONTENT,
        isContradiction: isOrderingContradictionComment,
    },
    {
        label: 'unbounded-fanout-cap',
        path: CAP_FIXTURE_PATH,
        buggyContent: CAP_BUGGY_CONTENT,
        isContradiction: isCapContradictionComment,
    },
    {
        label: 'cross-tenant-cache-key-collision',
        path: COLLISION_FIXTURE_PATH,
        buggyContent: COLLISION_BUGGY_CONTENT,
        isContradiction: isCollisionContradictionComment,
    },
];

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
            body: `Automated PR opened by Kodus E2E run ${ctx.runId}. Introduces ${DECISION_FIXTURES.length} deliberate bugs (${DECISION_FIXTURES.map((f) => f.label).join(', ')}) in throwaway fixture files, then applies each fix for real and re-reviews.`,
            fixtureFiles: Object.fromEntries(
                DECISION_FIXTURES.map((f) => [f.path, f.buggyContent]),
            ),
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
                    ? `Round 1 pipeline started (heartbeat at ${pipelineStartedAt}) but produced 0 findings on PR #${pr.number}. The fixtures (${DECISION_FIXTURES.map((f) => f.path).join(', ')}) each have a deliberate bug — any decent LLM should flag at least one.`
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

            // ---- Extract Kody's REAL suggestion for EACH fixture and apply
            // it verbatim ----
            const suggestedFixes: Record<string, string> = {};
            for (const fixture of DECISION_FIXTURES) {
                const round1Bodies = await ctx.provider.listReviewCommentBodies!(
                    { number: pr.number },
                    { sinceIso: sinceIsoRound1, path: fixture.path },
                );
                const suggestedFix = round1Bodies
                    .map(extractSuggestedCode)
                    .find((code): code is string => code !== null);
                ctx.assert(
                    suggestedFix !== undefined,
                    `Round 1 flagged the bug on ${fixture.path} (${fixture.label}) but none of its ` +
                        `${round1Bodies.length} comment(s) contained a parseable suggested-code block — ` +
                        `can't apply a real fix. Comment(s):\n${round1Bodies.map((c) => `---\n${c.slice(0, 500)}`).join('\n')}`,
                );
                suggestedFixes[fixture.path] = suggestedFix!;
            }

            // ---- Apply every fix for real, push a genuine 2nd commit.
            // Bundles a second, unrelated buggy file in with the fixes — see
            // QUALITY_CHECK_PATH's comment above for why. ----
            const sinceIsoRound2 = new Date().toISOString();
            await ctx.provider.pushFollowupCommit!(
                pr,
                {
                    ...suggestedFixes,
                    [QUALITY_CHECK_PATH]: QUALITY_CHECK_BUGGY_CONTENT,
                },
                "[e2e] apply Kody's suggested fixes verbatim + introduce an unrelated bug",
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

            // ---- Round 2 checks, per fixture: no comment on ANY fixture
            // file may suggest reversing that fixture's own already-applied
            // fix. Each fixture models a real, ground-truth-confirmed #1313
            // contradiction shape found in production, so a regression here
            // is a genuine repeat of a real bug, not a hypothetical. ----
            const round2Results: Record<
                string,
                { comments: number; contradictions: number }
            > = {};
            for (const fixture of DECISION_FIXTURES) {
                const round2Bodies = await ctx.provider.listReviewCommentBodies!(
                    { number: pr.number },
                    { sinceIso: sinceIsoRound2, path: fixture.path },
                );
                const contradictions = round2Bodies.filter(fixture.isContradiction);
                ctx.assert(
                    contradictions.length === 0,
                    `Round 2 posted ${contradictions.length} comment(s) on ${fixture.path} ` +
                        `(${fixture.label}) that suggest UNDOING the fix already applied in round 1 — ` +
                        `this is the #1313 symptom (Kody contradicting a decision from an earlier ` +
                        `review round). Offending comment(s):\n${contradictions.map((c) => `---\n${c.slice(0, 500)}`).join('\n')}`,
                );
                round2Results[fixture.path] = {
                    comments: round2Bodies.length,
                    contradictions: contradictions.length,
                };
            }

            // ---- Quality-regression guard: memory must not suppress a
            // genuinely new, unrelated finding bundled into the same commit ----
            const qualityCheckBodies = await ctx.provider.listReviewCommentBodies!(
                { number: pr.number },
                { sinceIso: sinceIsoRound2, path: QUALITY_CHECK_PATH },
            );
            ctx.assert(
                qualityCheckBodies.length > 0,
                `Round 2 found 0 comment(s) on ${QUALITY_CHECK_PATH}, a brand-new deliberate ` +
                    `missing-null-check bug bundled into the SAME commit as the fixes — this file has ` +
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
                    perFixture: round2Results,
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
