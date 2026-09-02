/**
 * The connection probe's ONE call — issued through the same montagem a review
 * uses, not a hand-rolled copy of it.
 *
 * Why this exists: the probe used to rebuild the request itself with axios (a
 * `/models` GET for native brands, a hand-written chat body for the compatible
 * ones). That copy could not help drifting from runtime — it never emitted
 * reasoning at all, sent temperature on only one of the two transports, and had
 * no case for Azure, so "Test" reported OK for configs a review would reject.
 *
 * Here the slot goes through `resolveModelConfig` — the same resolver
 * `structured-review-call` and `agent-loop-call` use — so every per-model fact
 * the provider modules own (Kimi k2.7-code's pinned temperature and
 * undisableable thinking, Anthropic 4.7+ rejecting sampling params, a brand's
 * reasoning schema) applies to the probe for free, and keeps applying when a
 * module changes. Divergence stops being something to remember and becomes
 * impossible.
 */
import { generateText } from 'ai';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { resolveModelConfig } from '@libs/llm/model-invocation';
import {
    reasoningEffortWasDropped,
    unreachedOverrideKeys,
    type UnreachedKey,
} from '@libs/llm/override-reachability';
import { buildReasoningProviderOptions } from '@libs/llm/reasoning-options';

/** A probe must answer fast or not at all — the connect form is waiting. */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * Floor for the completion budget. A thinking model rejects a request whose
 * `max_tokens` doesn't exceed its reasoning budget, so a 1-token probe would
 * 400 for the wrong reason on Kimi k2.7 / Claude — failing a config that
 * actually works. Kept small: this is a "does it answer" check, not a sample.
 */
const PROBE_MAX_OUTPUT_TOKENS = 16;

/** Headroom over the reasoning budget so the model can emit a visible token. */
const BUDGET_HEADROOM_TOKENS = 64;

/**
 * Largest reasoning budget declared anywhere in the resolved providerOptions.
 * The shape is provider-specific by design (each module owns its namespace), so
 * this reads the fact structurally — any `budgetTokens` / `budget_tokens` at any
 * depth — instead of hardcoding one provider's layout.
 */
export function reasoningBudgetFrom(
    providerOptions: Record<string, unknown> | undefined,
): number | undefined {
    let max: number | undefined;
    const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(
            node as Record<string, unknown>,
        )) {
            if (
                (key === 'budgetTokens' || key === 'budget_tokens') &&
                typeof value === 'number' &&
                Number.isFinite(value)
            ) {
                max = max === undefined ? value : Math.max(max, value);
            }
            visit(value);
        }
    };
    visit(providerOptions);
    return max;
}

/**
 * The completion budget for the probe: enough to clear the reasoning budget the
 * resolved options ask for, otherwise the small floor.
 */
export function probeMaxOutputTokens(
    providerOptions: Record<string, unknown> | undefined,
): number {
    const budget = reasoningBudgetFrom(providerOptions);
    return budget === undefined
        ? PROBE_MAX_OUTPUT_TOKENS
        : budget + BUDGET_HEADROOM_TOKENS;
}

/**
 * Strip the throughput policy from a slot before probing. rpm / tpm /
 * cooldownMs / maxConcurrentRequests govern how many review calls may run, not
 * whether this credential and model work — and honoring them here would let a
 * configured rate limit stall (or a cooldown block) the connect form. The
 * inference-shaping fields (model, temperature, reasoning, baseURL, auth) are
 * all kept, which is the whole point.
 */
export function slotForProbe(slot: NormalizedModel): NormalizedModel {
    const {
        rpm: _rpm,
        tpm: _tpm,
        cooldownMs: _cooldownMs,
        maxConcurrentRequests: _maxConcurrentRequests,
        fallback: _fallback,
        ...inferenceShape
    } = slot;
    return inferenceShape as NormalizedModel;
}

/**
 * Transport that refuses to follow redirects.
 *
 * The SSRF gate resolves the endpoint the user typed and rejects loopback /
 * RFC1918 / link-local targets — but it can only vouch for the host it checked.
 * A hostile endpoint answering 30x would otherwise bounce the request (and the
 * credential) to somewhere like the cloud metadata service AFTER the check
 * passed. The axios probe set `maxRedirects: 0` for exactly this; `fetch`
 * follows redirects by default, so the guard has to be reinstated here.
 */
export const noRedirectFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, redirect: 'error' });

export interface ProbeSlotResult {
    latencyMs: number;
    /**
     * Keys from the user's Custom reasoning override that left no trace in the
     * request the adapter built — see `override-reachability.ts`. Empty unless
     * the slot carries an override, since that is the only case where the
     * resolved `providerOptions` are the user's own words.
     */
    unreachedOverrideKeys: UnreachedKey[];
    /**
     * The effort the slot configured, when it produced nothing the provider will
     * see. Undefined when the effort landed, when none was set, or when a Custom
     * override is in play (that path reports per key above instead).
     */
    droppedReasoningEffort?: string;
}

/**
 * Issue the minimal real call for a slot. Resolves through the runtime path,
 * so the request carries exactly the tuning + reasoning the review would send.
 * Throws the SDK's error untouched — the caller owns classification.
 */
export async function probeSlotCall(
    slot: NormalizedModel,
    opts: { runName?: string; timeoutMs?: number } = {},
): Promise<ProbeSlotResult> {
    const inv = resolveModelConfig(slotForProbe(slot), {
        runName: opts.runName ?? 'byok-connection-probe',
        // Providers whose endpoint comes from the user honor this transport;
        // fixed-endpoint ones ignore it (they have no untrusted host to reach).
        modelOptions: { fetch: noRedirectFetch },
        // No reporter: a user testing a key in the settings screen must not feed
        // the BYOK error-threshold notification that watches real review traffic.
        //
        // `reasoningEffortDefault: 'none'` mirrors the review executor — an unset
        // slot adds no reasoning of its own, so the probe tests what was
        // configured rather than a default the review wouldn't apply.
        reasoningEffortDefault: 'none',
        openrouterProviderOrder: slot.openrouterProviderOrder,
        openrouterAllowFallbacks: slot.openrouterAllowFallbacks,
    });

    const { temperature } = inv.callOptions;
    const maxOutputTokens = probeMaxOutputTokens(inv.providerOptions);

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
    try {
        const result = await generateText({
            model: inv.model as any,
            // The SDK retries twice by default; a probe must report the first
            // answer it gets, not triple a user's failing request.
            maxRetries: 0,
            abortSignal: controller.signal,
            messages: [{ role: 'user', content: 'ping' }],
            maxOutputTokens,
            // Ask the SDK to keep the body it built. It is off by default because
            // a body can be large (images, files) — a 'ping' with no tools is
            // neither, and it is the only way to see which of the user's pasted
            // keys the adapter kept. Deliberately NOT enabled on review traffic,
            // where the bodies are exactly the large ones the default guards
            // against.
            include: { requestBody: true },
            ...(temperature != null ? { temperature } : {}),
            ...(Object.keys(inv.providerOptions).length > 0
                ? { providerOptions: inv.providerOptions as any }
                : {}),
        });
        const effort = slot.reasoningEffort;
        const effortDropped =
            !slot.reasoningConfigOverride &&
            !!effort &&
            effort !== 'none' &&
            reasoningEffortWasDropped(
                // The reasoning payload ALONE, asked of the same builder the
                // resolver uses. Reading it off `inv.providerOptions` would fold
                // in OpenRouter routing, and routing that lands would read as
                // reasoning that landed.
                buildReasoningProviderOptions(slot.provider, effort, slot.model),
                result.request?.body,
            );

        return {
            latencyMs: Date.now() - start,
            unreachedOverrideKeys: slot.reasoningConfigOverride
                ? unreachedOverrideKeys(
                      inv.providerOptions as Record<string, unknown>,
                      result.request?.body,
                  )
                : [],
            droppedReasoningEffort: effortDropped ? effort : undefined,
        };
    } finally {
        clearTimeout(timer);
    }
}
