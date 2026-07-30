import { ensureLicenseSeat } from "../lib/onboarding.js";
import { http } from "../lib/http.js";
import type { RunContext, Scenario, KodusSession } from "../lib/types.js";

// Anthropic-BYOK variant of conversation-vertex-byok: drives the REAL @kody
// conversation flow (webhook → ConversationAgent → BYOKPromptRunner → Anthropic
// Sonnet → kodus-flow parser) on a real self-hosted env. Used to reproduce the
// "Missing or invalid reasoning field" failure (old flow) and verify the fix
// (new flow) end-to-end. Hardened: rejects the generic error fallback.
const FIXTURE = { head: "bug/missing-null-check", base: "main" };
const QUESTION =
    "@kody this cron deactivates licenses daily, right? explain it to me naturally, like a colleague would, briefly.";

async function setAnthropicByok(
    apiBaseUrl: string,
    session: KodusSession,
    apiKey: string,
    model: string,
): Promise<void> {
    const provider = process.env.CONVERSATION_BYOK_PROVIDER || "anthropic";
    const reasoningEffort = process.env.CONVERSATION_BYOK_REASONING || "low";
    const main = { provider, apiKey, model, reasoningEffort };
    const auth = { Authorization: `Bearer ${session.accessToken}` };
    const test = await http<{ data?: { ok?: boolean; message?: string } }>(
        `${apiBaseUrl}/organization-parameters/test-byok`,
        { method: "POST", headers: auth, body: main, timeoutMs: 40_000 },
    );
    if (!test.body?.data?.ok) {
        const reason = test.body?.data?.message ?? test.raw.slice(0, 300);
        throw new Error(`Anthropic BYOK test-byok failed for ${model}: ${reason}`);
    }
    const save = await http(
        `${apiBaseUrl}/organization-parameters/create-or-update`,
        {
            method: "POST",
            headers: auth,
            body: { key: "byok_config", configValue: { main, fallback: null } },
            timeoutMs: 25_000,
        },
    );
    if (save.status < 200 || save.status >= 300) {
        throw new Error(`setAnthropicByok save failed: HTTP ${save.status} ${save.raw.slice(0, 200)}`);
    }
}

export const conversationAnthropicByok: Scenario = {
    id: "conversation-anthropic-byok",
    title: "Kody answers an @kody mention using an Anthropic Sonnet BYOK key (v2 path)",
    priority: "P2",
    appliesTo: {
        target: ["self-hosted"],
        provider: ["github"],
        license: ["paid", "license-paid"],
    },
    timeoutSec: 1200,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, "scenario requires a tenant");

        const apiKey =
            process.env.CONVERSATION_ANTHROPIC_KEY ||
            process.env.API_ANTHROPIC_API_KEY;
        if (!apiKey) {
            ctx.skip("CONVERSATION_ANTHROPIC_KEY / API_ANTHROPIC_API_KEY not set");
        }
        const model =
            process.env.CONVERSATION_ANTHROPIC_MODEL ||
            "claude-sonnet-4-5-20250929";

        const userToken = process.env.CONVERSATION_USER_TOKEN;
        if (!userToken) {
            ctx.skip("CONVERSATION_USER_TOKEN not set");
        }

        if (
            !ctx.provider.openPRFromBranches ||
            !ctx.provider.pollForKodyReply ||
            !ctx.provider.postReviewCommentAs
        ) {
            throw new Error(
                `Provider ${ctx.provider.name} does not implement the conversation hooks`,
            );
        }

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        await setAnthropicByok(ctx.target.apiBaseUrl, session, apiKey!, model);

        const pr = await ctx.provider.openPRFromBranches({
            head: FIXTURE.head,
            base: FIXTURE.base,
            title: `[e2e] conversation-anthropic-byok ${ctx.runId.slice(0, 8)}`,
            body: `Automated PR (Anthropic conversation: ${model}). Auto-closed by the scenario.`,
        });

        try {
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
                `Kody never answered the @kody mention on PR #${pr.number} within 600s (model=${model}).`,
            );

            // Reject the generic error fallback — a non-empty reply is NOT enough.
            const lowered = reply!.body.toLowerCase();
            const isFallback =
                lowered.includes("encountered an error while processing your request") ||
                lowered.includes("please try rephrasing your question");
            ctx.assert(
                !isFallback,
                `Kody replied with the GENERIC ERROR FALLBACK (the parse failure), not a real answer: "${reply!.body.slice(0, 300)}" (model=${model}).`,
            );

            return {
                prNumber: pr.number,
                prUrl: pr.url,
                model,
                replySample: reply!.body.slice(0, 300),
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

export default conversationAnthropicByok;
