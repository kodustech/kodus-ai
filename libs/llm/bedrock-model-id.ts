/**
 * Repair a Bedrock model id that AWS cannot serve as written.
 *
 * Claude on Bedrock has no on-demand throughput. Naming the foundation model
 * directly is rejected outright:
 *
 *   Invocation of model ID anthropic.claude-sonnet-4-6 with on-demand
 *   throughput isn't supported. Retry your request with the ID or ARN of an
 *   inference profile that contains this model.
 *
 * The fix AWS asks for is a geography-prefixed cross-region inference profile —
 * `us.`, `eu.`, `apac.` or `global.` — and four of the five Bedrock-Claude slots
 * in production already carry one. The fifth does not, and has therefore never
 * worked. It sits in a `fallback`, which is why nobody noticed: a fallback only
 * runs once the primary has already failed, so its error arrives inside an
 * outage rather than on its own.
 *
 * Repairing rather than reporting, because a bare `anthropic.*` id is not a
 * preference AWS happens to disagree with — it is unusable, every time, for
 * everyone. There is nothing for the user to decide.
 *
 * Deliberately narrow: only the Anthropic family, and only an id with no prefix
 * at all. The other families on Bedrock (`moonshotai.*`, `minimax.*`,
 * `openai.*`, `xai.*`) appear in production both bare and prefixed, and no
 * error has been observed for the bare ones. Repairing on a guess would break
 * ids that work today to fix ones nobody has shown are broken.
 */

/** Already an inference profile, an ARN, or something we should not touch. */
const ALREADY_ROUTED = /^(us|eu|apac|global|us-gov)\.|^arn:/i;

/** A bare Anthropic foundation-model id: `anthropic.claude-…`. */
const BARE_ANTHROPIC = /^anthropic\./i;

/**
 * The geography prefix for a region. AWS names cross-region profiles after the
 * geography, not the region: every `eu-*` region shares `eu.`, every `ap-*`
 * shares `apac.`. `global.` is the routing-anywhere profile and is not derived
 * from a region, so it is never inferred here.
 */
export function bedrockGeographyPrefix(region?: string): string {
    const r = (region ?? '').trim().toLowerCase();
    if (r.startsWith('eu-')) {
        return 'eu.';
    }
    if (r.startsWith('ap-')) {
        return 'apac.';
    }
    // us-* and anything unrecognized: `us.` is the default region's geography,
    // and the slot's own default region is us-east-1.
    return 'us.';
}

/**
 * The model id to send to Bedrock. Returns the input unchanged unless it is a
 * bare Anthropic id, which AWS refuses.
 */
export function repairBedrockModelId(model: string, region?: string): string {
    const id = (model ?? '').trim();
    if (!id || ALREADY_ROUTED.test(id) || !BARE_ANTHROPIC.test(id)) {
        return model;
    }
    return `${bedrockGeographyPrefix(region)}${id}`;
}
