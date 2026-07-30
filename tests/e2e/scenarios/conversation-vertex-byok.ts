import { ensureLicenseSeat } from '../lib/onboarding.js';
import { readVertexByokEnv, setVertexByok } from '../lib/vertex-byok.js';
import type { RunContext, Scenario } from '../lib/types.js';

// Standing-branch fixture (same repo as code-review-vertex-byok). The PR
// content is irrelevant here — we only need an open PR to talk to Kody on.
const FIXTURE = { head: 'bug/missing-null-check', base: 'main' };

// `@kody <question>` (NOT `@kody review`) is what the webhook handlers match
// with KODY_MENTION_NON_REVIEW_PATTERN to route the comment to the
// adapter). A review command would take the v5 agent path instead.
const QUESTION =
    '@kody in one short sentence, what does this pull request change?';

/**
 * Proves Kody's CONVERSATION path honors a Claude-on-Vertex BYOK key. The
 * conversation agent runs on the legacy v2 langchain engine
 * (BaseAgentProvider builds `new BYOKPromptRunnerService(byokConfig)`), so a
 * broken Vertex routing there means Kody silently never answers an `@kody`
 * mention — distinct from the code-review path (which is v5/Vercel SDK).
 */
export const conversationVertexByok: Scenario = {
    id: 'conversation-vertex-byok',
    title: 'Kody answers an @kody mention using a Claude-on-Vertex BYOK key (v2 path)',
    priority: 'P2',
    appliesTo: {
        target: ['self-hosted'],
        provider: ['github'],
        license: ['paid', 'license-paid'],
    },
    timeoutSec: 1200,
    async run(ctx: RunContext) {
        ctx.assert(
            ctx.tenant,
            'scenario requires a tenant (set SH_TENANT_EMAIL/_PASSWORD)',
        );
        // Skip (not fail) when a required secret is absent — keeps the matrix
        // green on CI runners that don't have Vertex / the conversation user
        // wired.
        const vertex = readVertexByokEnv();
        if (!vertex) {
            ctx.skip(
                'VERTEX_SA_JSON not set — needs a GCP service-account JSON (raw or base64) for a project with Vertex AI on and the Claude model enabled in Model Garden',
            );
        }

        // Kody ignores any comment whose author login contains "kody"/"kodus"
        // (isKodyComment, LOGIN_KEYWORDS=['kody','kodus']) — and the e2e bots
        // are all `kodus-e2e-bot-N`. So the `@kody` mention MUST be posted by a
        // separate, non-Kody GitHub account.
        const userToken = process.env.CONVERSATION_USER_TOKEN;
        if (!userToken) {
            ctx.skip(
                "CONVERSATION_USER_TOKEN not set — needs a GitHub token for an account whose login does NOT contain 'kody'/'kodus' (the integration bot's own comments are ignored by Kody) with Pull requests R/W on the fixture repo",
            );
        }

        if (
            !ctx.provider.openPRFromBranches ||
            !ctx.provider.pollForKodyReply ||
            !ctx.provider.postReviewCommentAs
        ) {
            throw new Error(
                `Provider ${ctx.provider.name} does not implement openPRFromBranches/pollForKodyReply/postReviewCommentAs yet`,
            );
        }

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        await setVertexByok(ctx.target.apiBaseUrl, session, vertex!);

        const pr = await ctx.provider.openPRFromBranches({
            head: FIXTURE.head,
            base: FIXTURE.base,
            title: `[e2e] conversation-vertex-byok ${ctx.runId.slice(0, 8)}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId} (Claude-on-Vertex conversation: ${vertex!.model} @ ${vertex!.region}). Auto-closed by the scenario.`,
        });

        try {
            // Post the @kody mention AFTER the PR exists, as an inline review
            // comment (Kody only answers review comments, not issue comments).
            // sinceIso brackets the poll so we only see replies after it.
            const sinceIso = new Date().toISOString();
            const trigger = await ctx.provider.postReviewCommentAs(
                pr.number,
                QUESTION,
                userToken!,
            );

            const reply = await ctx.provider.pollForKodyReply(
                { number: pr.number },
                { sinceIso, triggerId: trigger.id, timeoutSec: 600 },
            );

            ctx.assert(
                reply && reply.body.trim().length > 0,
                `Kody never answered the @kody mention on PR #${pr.number} within 600s (model=${vertex!.model}, region=${vertex!.region}). The conversation agent runs on the v2 langchain engine — suspect Vertex routing on that path, the model not enabled in Model Garden, or the conversation feature disabled for the tenant.`,
            );

            // A non-empty reply is NOT enough: when thought generation fails
            // (e.g. the ReActStrategy parser rejecting the model's response),
            // the agent still POSTS a generic fallback comment. A length-only
            // check would go green while Kody is actually broken — which is how
            // the "Missing or invalid reasoning field" regression hid for weeks.
            // Reject the fallback text so this scenario detects parse failures.
            const FALLBACK_MARKERS = [
                'encountered an error while processing your request',
                'please try rephrasing your question',
            ];
            const loweredReply = reply!.body.toLowerCase();
            const isFallback = FALLBACK_MARKERS.some((m) =>
                loweredReply.includes(m),
            );
            ctx.assert(
                !isFallback,
                `Kody replied on PR #${pr.number} with the GENERIC ERROR FALLBACK instead of a real answer: "${reply!.body.slice(0, 200)}". This is the @kody conversation thought-generation/parse failure (model=${vertex!.model}, region=${vertex!.region}), not a successful response.`,
            );

            return {
                prNumber: pr.number,
                prUrl: pr.url,
                model: vertex!.model,
                region: vertex!.region,
                replySample: reply!.body.slice(0, 200),
                sinceIso,
            };
        } finally {
            try {
                await ctx.provider.closePR(pr);
            } catch (err) {
                // best-effort cleanup
            }
        }
    },
};

export default conversationVertexByok;
