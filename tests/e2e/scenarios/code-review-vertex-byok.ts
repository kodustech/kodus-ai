import { ensureLicenseSeat } from "../lib/onboarding.js";
import { http } from "../lib/http.js";
import type { KodusSession, RunContext, Scenario } from "../lib/types.js";

// Same deliberate-bug fixture as code-review-basic (kodus-e2e/tiny-url):
// missing null-check + misleading comment + unsafe `as string` cast. Any
// competent model flags at least one — so "0 findings" means a real
// regression (here: Claude-on-Vertex routing) rather than a clean diff.
const FIXTURE = { head: "bug/missing-null-check", base: "main" };

interface VertexByok {
    saJson: string;
    region: string;
    model: string;
}

/**
 * Point the org's main BYOK slot at a Claude model on Google Vertex. Probes
 * /test-byok first so a missing Model-Garden enablement or a bad service
 * account fails HERE with Google's actual reason — not later as a silent
 * "0 findings" review.
 */
async function setVertexByok(
    apiBaseUrl: string,
    session: KodusSession,
    cfg: VertexByok,
): Promise<void> {
    const main = {
        provider: "google_vertex",
        apiKey: cfg.saJson,
        model: cfg.model,
        vertexLocation: cfg.region,
    };
    const auth = { Authorization: `Bearer ${session.accessToken}` };

    const test = await http<{ data?: { ok?: boolean; message?: string } }>(
        `${apiBaseUrl}/organization-parameters/test-byok`,
        { method: "POST", headers: auth, body: main, timeoutMs: 40_000 },
    );
    if (!test.body?.data?.ok) {
        const reason = test.body?.data?.message ?? test.raw.slice(0, 300);
        throw new Error(
            `Vertex BYOK test-byok failed for ${cfg.model} @ ${cfg.region}: ${reason}`,
        );
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
        throw new Error(
            `setVertexByok save failed: HTTP ${save.status} ${save.raw.slice(0, 200)}`,
        );
    }
}

export const codeReviewVertexByok: Scenario = {
    id: "code-review-vertex-byok",
    title: "Kody reviews a PR using a Claude-on-Vertex BYOK key (self-hosted)",
    priority: "P1",
    appliesTo: {
        // Self-hosted is the durable target: it runs the GA agent-first engine
        // and is gated purely by the catalog (no PostHog), so this is the path
        // a self-hosted customer's own Vertex key actually takes.
        target: ["self-hosted"],
        provider: ["github"],
        license: ["paid", "license-paid"],
    },
    // Phase A (600s) + pollForReview (1500s) + onboarding/PR overhead.
    timeoutSec: 2700,
    async run(ctx: RunContext) {
        ctx.assert(
            ctx.tenant,
            "scenario requires a tenant (set SH_TENANT_EMAIL/_PASSWORD)",
        );

        // Provisioning requirement (one-time, in Google Cloud): a service
        // account JSON for a project with the Vertex AI API enabled AND the
        // chosen Claude model enabled in Vertex AI Model Garden (Anthropic
        // models are per-project opt-in). `global` + a bare-id model like
        // claude-sonnet-4-6 avoids regional-availability gotchas.
        const saJson = process.env.VERTEX_SA_JSON;
        // Skip (not fail) when the Vertex secret is absent — keeps the matrix
        // green on CI runners that don't have the GCP service account wired.
        if (!saJson) {
            ctx.skip(
                "VERTEX_SA_JSON not set — needs a GCP service-account JSON (raw or base64) for a project with Vertex AI on and the Claude model enabled in Model Garden",
            );
        }
        const region = process.env.VERTEX_REGION || "global";
        const model = process.env.VERTEX_MODEL || "claude-sonnet-4-6";

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        // Configure Claude-on-Vertex BYOK before opening the PR so the review
        // pipeline runs on it.
        await setVertexByok(ctx.target.apiBaseUrl, session, {
            saJson: saJson!,
            region,
            model,
        });

        if (!ctx.provider.openPRFromBranches) {
            throw new Error(
                `Provider ${ctx.provider.name} does not implement openPRFromBranches yet`,
            );
        }

        const sinceIso = new Date().toISOString();
        const pr = await ctx.provider.openPRFromBranches({
            head: FIXTURE.head,
            base: FIXTURE.base,
            title: `[e2e] code-review-vertex-byok ${ctx.runId.slice(0, 8)}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId} (Claude-on-Vertex BYOK: ${model} @ ${region}). Auto-closed by the scenario.`,
        });

        try {
            let pipelineStartedAt: string | undefined;
            if (ctx.provider.waitForPipelineStart) {
                // Generous start budget: the GitHub rate-limit gate can defer
                // the review job by minutes under load (see code-review-basic).
                const started = await ctx.provider.waitForPipelineStart(
                    { number: pr.number },
                    { sinceIso, timeoutSec: 600 },
                );
                pipelineStartedAt = started.startedAt;
            }

            const pollStartMs = Date.now();
            const review = await ctx.provider.pollForReview(
                { number: pr.number },
                { sinceIso, timeoutSec: 1500 },
            );
            const reviewLatencySec = Math.round(
                (Date.now() - pollStartMs) / 1000,
            );

            ctx.assert(
                review.reviewComments + review.issueComments + review.reviews >
                    0,
                `Claude-on-Vertex review produced 0 findings on PR #${pr.number} within ${reviewLatencySec}s (model=${model}, region=${region}). The fixture branch '${FIXTURE.head}' has deliberate bugs — expect ≥1 finding. Suspect: Vertex routing regression, the model not enabled in Model Garden, or an LLM quality regression.`,
            );

            return {
                prNumber: pr.number,
                prUrl: pr.url,
                model,
                region,
                reviewLatencySec,
                pipelineStartedAt,
                sinceIso,
                review,
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

export default codeReviewVertexByok;
