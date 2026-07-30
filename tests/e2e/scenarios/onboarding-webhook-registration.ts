import type { RunContext, Scenario, WebhookInfo } from "../lib/types.js";

// Validates the core onboarding wiring: after Kodus completes the
// auth-integration + repositories + finish-onboarding flow for a given
// provider, the provider's repo/project must have at least one webhook
// pointing back at Kodus. If this step silently fails (e.g. the GitLab
// fire-and-forget bug at gitlab.service.ts:712), nothing downstream
// works — PRs/MRs are opened, events fire, but Kodus never hears them.
//
// This scenario is intentionally lightweight (no LLM, no review pipeline)
// so it runs in ~30s and acts as a fast preflight gate per (target,
// provider) cell. We pre-clean matching hooks so a stale leftover from
// a previous (working) run can't mask a current regression.
//
// Assertions are deliberately minimal:
//   - ≥1 webhook URL ends with provider.webhookPath
//   - it's active
// We do NOT assert specific event subscriptions here — wrong event set
// surfaces as a code-review-basic failure (events fire but Kodus filters
// them out). The job of THIS scenario is just to prove the URL got
// registered at all.
export const onboardingWebhookRegistration: Scenario = {
    id: "onboarding-webhook-registration",
    title:
        "After onboarding, a Kodus webhook is registered on the provider's repo/project",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        // github-app is intentionally excluded: GitHub Apps don't
        // register per-repo webhooks via the REST API (no
        // /repos/{owner}/{repo}/hooks entry). The webhook URL is
        // configured ONCE at the App registration level on
        // github.com, and GitHub delivers events to every install
        // automatically. This scenario asserts that Kodus
        // auto-registered a hook via REST after onboarding — it
        // would always fail for github-app, but for the right reason
        // (the App's webhook isn't supposed to appear there).
        provider: ["github", "gitlab", "bitbucket", "azure-devops"],
        // Webhook registration is independent of license tier — it
        // happens during onboarding regardless. We only run it on `paid`
        // tiers because that's where the rest of the matrix lives;
        // adding free/trial here would just duplicate the gate.
        license: ["paid", "license-paid"],
    },
    timeoutSec: 120,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, "scenario requires a tenant");

        const session = await ctx.kodus.login(ctx.tenant!);

        // Pre-clean: drop any existing Kodus-shaped webhooks so we can
        // assert THIS run's onboarding registered a fresh one. Without
        // this, a hook left over from a previous (working) Kodus build
        // would mask a current regression.
        // Match on path-containment rather than endsWith — Azure DevOps
        // appends `?token=<hmac>` to the consumer URL for webhook
        // authentication, so the raw URL ends with the token, not with
        // /azure-repos/webhook. Other providers don't append anything
        // and the contains-check still matches them.
        const expectedPath = ctx.provider.webhookPath;
        const matchesKodus = (h: WebhookInfo) =>
            h.url.includes(expectedPath);

        const preExisting = await ctx.provider.listWebhooks();
        const stale = preExisting.filter(matchesKodus);
        for (const h of stale) {
            try {
                await ctx.provider.deleteWebhook(h.id);
            } catch {
                // best-effort — if cleanup fails, the assertion below
                // still surfaces the real issue (e.g. permissions).
            }
        }

        await ctx.kodus.registerIntegration(session);
        // forceRecreate: this scenario just deleted the repo's webhook in
        // the pre-clean above and asserts registerRepo recreated it, so it
        // must bypass the per-run registration cache (which otherwise skips
        // the POST that re-creates the hook).
        const repo = await ctx.kodus.registerRepo(session, {
            forceRecreate: true,
        });
        await ctx.kodus.finishOnboarding(session, repo);

        const after = await ctx.provider.listWebhooks();
        const kodusHooks = after.filter(matchesKodus);

        ctx.assert(
            kodusHooks.length > 0,
            `Kodus did not register a webhook on ${ctx.provider.name} after onboarding. ` +
                `Expected ≥1 hook with URL containing '${expectedPath}', found ${after.length} hooks total, ` +
                `${kodusHooks.length} matching. URLs: ${JSON.stringify(after.map((h) => h.url))}`,
        );

        const active = kodusHooks.filter((h) => h.active);
        ctx.assert(
            active.length > 0,
            `Kodus webhook(s) registered but none are active: ${JSON.stringify(kodusHooks)}`,
        );

        return {
            staleRemoved: stale.length,
            registered: kodusHooks.map((h) => ({
                id: h.id,
                url: h.url,
                active: h.active,
                events: h.events,
            })),
        };
    },
};

export default onboardingWebhookRegistration;
