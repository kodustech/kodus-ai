import { ensureLicenseSeat } from '../lib/onboarding.js';
import { resolveConversationUserToken } from '../lib/conversation-user-token.js';
import { isKodyConversationAnswer } from '../lib/kody-markers.js';
import { pollUntil } from '../providers/base.js';
import type { ReviewThread, RunContext, Scenario } from '../lib/types.js';

// #1946: a reply in a thread Kody started gets an answer without @kody, and
// Kody stays out of replies meant for someone else and out of threads a
// person started. Drives the real path: provider webhook → handler forwards
// the reply → gate → classifier (LLM.run) → conversation agent.
//
// The PR plants three findings so Kody opens at least two threads: one gets
// a reply meant for Kody, the other a reply meant for a teammate.

const BUGGY_FILE = `const db = require('./db');

async function findUserByEmail(email) {
    const result = await db.query(
        \`SELECT id, name, password_hash FROM users WHERE email = '\${email}'\`,
    );
    return result.rows[0].name.toUpperCase();
}

async function deactivateUsers(ids) {
    for (const id of ids) {
        db.query('UPDATE users SET active = false WHERE id = $1', [id]);
    }
    return { deactivated: ids.length };
}

module.exports = { findUserByEmail, deactivateUsers };
`;

const TO_KODY =
    'Why would this be a problem here? The value comes from our own login form, which already validates it.';
const TO_TEAMMATE =
    "@e2e-teammate can you take this one? I'm out tomorrow and won't get to it.";
const HUMAN_THREAD_ROOT = 'Should this module log the lookups for auditing?';
const HUMAN_THREAD_REPLY = 'Probably, but in a separate PR.';

const HUMAN_THREAD_PROVIDERS = new Set(['github', 'bitbucket']);

// Silence is proven by waiting: the classifier answers in seconds once the
// webhook lands, so three minutes covers queueing on a busy worker.
const SILENCE_WAIT_SEC = 180;

export const conversationImplicitReply: Scenario = {
    id: 'conversation-implicit-reply',
    title: 'Kody answers replies in its own threads without @kody, and stays out of the rest',
    priority: 'P2',
    appliesTo: {
        target: ['self-hosted', 'cloud'],
        provider: ['github', 'gitlab', 'bitbucket', 'azure-devops'],
        license: ['paid', 'license-paid'],
    },
    timeoutSec: 2700,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, 'scenario requires a tenant');
        const provider = ctx.provider;

        const { token: userToken, missingEnvHint } =
            resolveConversationUserToken(provider.name);
        if (!userToken) {
            ctx.skip(`${missingEnvHint} not set`);
        }
        if (
            !provider.listKodyThreads ||
            !provider.replyInThread ||
            !provider.threadComments ||
            !provider.postReviewCommentAs
        ) {
            throw new Error(
                `Provider ${provider.name} does not implement the thread hooks`,
            );
        }

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        await ensureLicenseSeat(ctx.target, session, provider);

        // runId ends in a random suffix; its date prefix repeats all month.
        const runTag = ctx.runId.slice(-6);
        const pr = await provider.openPR({
            branch: `e2e/implicit-reply-${runTag}`,
            title: `[e2e] conversation-implicit-reply ${runTag}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId}. Auto-closed by the scenario.`,
            fixtureFiles: { 'src/e2e-implicit-reply/users.js': BUGGY_FILE },
        });

        try {
            const threads = await pollUntil<ReviewThread[]>(
                async () => {
                    const found = await provider.listKodyThreads!(pr.number);
                    return found.length >= 2 ? found : null;
                },
                { timeoutSec: 1500, intervalSec: 15 },
            );
            ctx.assert(
                threads,
                `Kody opened fewer than 2 review threads on PR #${pr.number} within 1500s`,
            );
            const [toKodyThread, toTeammateThread] = threads!;

            // Everything the harness posts, so any other new comment in a
            // thread is Kody's (it may post as the harness account).
            const ours = new Set<string>();
            const kodyIn = async (threadId: string, before: Set<string>) =>
                (await provider.threadComments!(pr.number, threadId)).filter(
                    (c) =>
                        !before.has(c.id) &&
                        !ours.has(c.id) &&
                        !c.body
                            .toLowerCase()
                            .trim()
                            .startsWith('analyzing your request'),
                );
            const snapshot = async (threadId: string) =>
                new Set(
                    (await provider.threadComments!(pr.number, threadId)).map(
                        (c) => c.id,
                    ),
                );

            // 1. Reply meant for Kody, without @kody → one answer.
            const beforeToKody = await snapshot(toKodyThread.id);
            ours.add(
                (
                    await provider.replyInThread!(
                        pr.number,
                        toKodyThread.id,
                        TO_KODY,
                        userToken!,
                    )
                ).id,
            );

            // 2. Reply meant for a teammate, in another Kody thread.
            const beforeToTeammate = await snapshot(toTeammateThread.id);
            ours.add(
                (
                    await provider.replyInThread!(
                        pr.number,
                        toTeammateThread.id,
                        TO_TEAMMATE,
                        userToken!,
                    )
                ).id,
            );

            // 3. A thread a person started, with a reply in it. Only where
            // the posted comment's id is also its thread's id; on GitLab and
            // Azure it is a note id, and the unit tests cover that gate.
            const humanRoot = HUMAN_THREAD_PROVIDERS.has(provider.name)
                ? await provider.postReviewCommentAs(
                      pr.number,
                      HUMAN_THREAD_ROOT,
                      userToken!,
                  )
                : null;
            if (humanRoot) {
                ours.add(humanRoot.id);
                ours.add(
                    (
                        await provider.replyInThread!(
                            pr.number,
                            humanRoot.id,
                            HUMAN_THREAD_REPLY,
                            userToken!,
                        )
                    ).id,
                );
            }

            const answer = await pollUntil(
                async () => {
                    const fresh = await kodyIn(toKodyThread.id, beforeToKody);
                    return fresh.length ? fresh[0] : null;
                },
                { timeoutSec: 600, intervalSec: 10 },
            );
            ctx.assert(
                answer,
                `Kody did not answer the reply without @kody in thread ${toKodyThread.id} on PR #${pr.number} within 600s`,
            );
            if (provider.name !== 'bitbucket') {
                ctx.assert(
                    isKodyConversationAnswer(answer!.body),
                    `Kody's answer in thread ${toKodyThread.id} lacks the conversation marker: "${answer!.body.slice(0, 200)}"`,
                );
            }

            // The answer's own webhook must not start a second answer, and
            // the two replies meant for people must stay unanswered.
            await new Promise((r) => setTimeout(r, SILENCE_WAIT_SEC * 1000));

            const answers = await kodyIn(toKodyThread.id, beforeToKody);
            ctx.assert(
                answers.length === 1,
                `Expected exactly one Kody answer in thread ${toKodyThread.id}, found ${answers.length}`,
            );
            const teammateThread = await kodyIn(
                toTeammateThread.id,
                beforeToTeammate,
            );
            ctx.assert(
                teammateThread.length === 0,
                `Kody answered a reply meant for a teammate in thread ${toTeammateThread.id}: "${teammateThread[0]?.body.slice(0, 200)}"`,
            );
            if (humanRoot) {
                const humanThread = await kodyIn(humanRoot.id, new Set());
                ctx.assert(
                    humanThread.length === 0,
                    `Kody answered in a thread a person started (${humanRoot.id}): "${humanThread[0]?.body.slice(0, 200)}"`,
                );
            }

            return {
                prNumber: pr.number,
                prUrl: pr.url,
                kodyThreads: threads!.length,
                answerSample: answer!.body.slice(0, 300),
            };
        } finally {
            try {
                await provider.closePR(pr);
            } catch {
                // best-effort cleanup
            }
        }
    },
};

export default conversationImplicitReply;
