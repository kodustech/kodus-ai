/**
 * ModelReasoningTraits — the per-MODEL facts that decide whether a STRUCTURED
 * call is valid, and the ONE pure function (`planStructuredCall`) that turns
 * those facts into an action. This is the decision layer of the BYOK reasoning
 * design: provider modules own the facts (`ProviderModule.reasoningTraits`),
 * generic code (model-invocation, the structured executor) reads this plan — no
 * `if (provider === …)` anywhere but the module that owns the model.
 *
 * Why it exists: whether a structured call 400s ("tool_choice 'required' is
 * incompatible with thinking enabled") depends on facts that live per MODEL, not
 * per provider-type:
 *   - does the model think unless told not to?                (Kimi k2.6, DeepSeek, Claude 5)
 *   - can thinking be turned off at all?                      (k2.7-code / k3 / Fable-Mythos / GLM-5.3 = NO)
 *   - does the endpoint even accept a FORCED tool_choice?     (GLM = auto-only)
 *   - does a forced tool_choice REJECT thinking?              (Kimi/Claude = yes, DeepSeek = no)
 * Deciding these per provider-type is exactly why fixes kept leaving gaps.
 *
 * How structured output is issued (tool-use vs response_format) is NOT duplicated
 * here — it is already `capabilities(model).structuredOutput` ('none' = forced
 * tool-use; 'json_schema'/'json_object' = response_format). `planStructuredCall`
 * takes that as its first input.
 */

export interface ModelReasoningTraits {
    /** Sends thinking/reasoning unless explicitly told not to. Drives the UI
     *  `supportsReasoning` flag and whether an omitted config means "off". */
    thinksByDefault: boolean;
    /** Accepts an explicit "off" (e.g. `thinking:{type:'disabled'}`). False for
     *  always-thinking models (Kimi k2.7-code/k3, Claude Fable/Mythos, GLM-5.3)
     *  — sending a disable to them is invalid. */
    canDisableThinking: boolean;
    /** The endpoint accepts a FORCED tool_choice (required/any/tool) at all.
     *  GLM's API is `auto`-only, so structured output there can never go through
     *  forced tool-use and must use response_format / a prompt-schema reroute. */
    supportsForcedToolChoice: boolean;
    /** A forced tool_choice is REJECTED while thinking is enabled (the Anthropic
     *  protocol rule — native Claude and Kimi enforce it; DeepSeek does NOT). Only
     *  meaningful when the call would use forced tool-use. */
    forcedToolChoiceRejectsThinking: boolean;
}

/** Safe default for a non-reasoning / unknown model: no thinking, no constraints.
 *  A provider without `reasoningTraits` behaves exactly as before this existed. */
export const NON_REASONING_TRAITS: ModelReasoningTraits = {
    thinksByDefault: false,
    canDisableThinking: true,
    supportsForcedToolChoice: true,
    forcedToolChoiceRejectsThinking: false,
};

/**
 * The single source of reasoning facts for models spoken over the Anthropic-
 * COMPATIBLE protocol (Kimi/Moonshot, GLM/Z.ai, DeepSeek, and unknown upstreams).
 * Both the anthropic module (native emission + traits) and the brand modules
 * (moonshot/zai delegate here) read this ONE table, so a new Kimi/GLM revision is
 * a one-line change caught by the contract test — never scattered per module.
 *
 * Sources: platform.kimi.ai (thinking-models), docs.z.ai (thinking-mode /
 * function-calling), api-docs.deepseek.com (thinking_mode / anthropic_api).
 */
export function resolveCompatibleReasoningTraits(
    model?: string,
): ModelReasoningTraits {
    const m = (model ?? '').toLowerCase();

    // GLM (Z.ai): the API supports tool_choice `auto` ONLY — a forced tool_choice
    // is never accepted, so structured output must reroute to response_format /
    // prompt-schema regardless of thinking. GLM-5.3 also forces thinking on.
    if (m.includes('glm')) {
        const alwaysThinking = m.includes('5.3') || m.includes('5-3');
        return {
            thinksByDefault: true,
            canDisableThinking: !alwaysThinking,
            supportsForcedToolChoice: false,
            forcedToolChoiceRejectsThinking: true,
        };
    }

    // Kimi (Moonshot): k2.7-code and k3 think ALWAYS and expose no disable; k2.5 /
    // k2.6 default-on but can be disabled with `thinking:{type:'disabled'}`.
    if (m.includes('kimi') || m.includes('moonshot')) {
        const alwaysThinking = m.includes('code') || m.includes('k3');
        return {
            thinksByDefault: true,
            canDisableThinking: !alwaysThinking,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: true,
        };
    }

    // DeepSeek: thinks by default, can disable (effort 'none'), and — unlike Kimi/
    // Claude — its Anthropic endpoint ACCEPTS a forced tool_choice WITH thinking.
    if (m.includes('deepseek')) {
        return {
            thinksByDefault: true,
            canDisableThinking: true,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: false,
        };
    }

    // Unknown Anthropic-compatible upstream: assume Anthropic semantics (thinks,
    // forced tool_choice rejects thinking) but disable-able — the safe suppress
    // path that has worked in production (matches prior behavior for k2.6).
    return {
        thinksByDefault: true,
        canDisableThinking: true,
        supportsForcedToolChoice: true,
        forcedToolChoiceRejectsThinking: true,
    };
}

export type StructuredOutputMode = 'json_schema' | 'json_object' | 'none';

/**
 * What a structured (Output.object) call must do on this model:
 *   - 'as-is'             → issue normally; thinking is compatible.
 *   - 'suppress-thinking' → force reasoning OFF (send disable), then the forced
 *                           tool_choice is valid. (Kimi k2.6, Claude-adaptive)
 *   - 'reroute-json'      → do NOT use forced tool_choice at all; use
 *                           response_format / schema-in-prompt so thinking may
 *                           stay on. (always-thinking models, and GLM which has
 *                           no forced tool_choice) — the universal floor.
 */
export type StructuredCallPlan = 'as-is' | 'suppress-thinking' | 'reroute-json';

/**
 * The WHOLE decision, once, for every provider. Pure — no I/O, no provider ids.
 * `structuredOutput` is the model's capability ('none' ⇒ the SDK issues
 * Output.object as forced tool-use; otherwise response_format).
 */
export function planStructuredCall(
    structuredOutput: StructuredOutputMode | undefined,
    traits: ModelReasoningTraits,
): StructuredCallPlan {
    // response_format (json_schema / json_object): no forced tool_choice is sent,
    // so thinking is always compatible — nothing to do.
    if (structuredOutput && structuredOutput !== 'none') {
        return 'as-is';
    }

    // From here the SDK would issue Output.object as a FORCED tool_choice.
    if (!traits.supportsForcedToolChoice) {
        return 'reroute-json';
    } // GLM: auto-only
    if (!traits.forcedToolChoiceRejectsThinking) {
        return 'as-is';
    } // DeepSeek: fine
    if (traits.canDisableThinking) {
        return 'suppress-thinking';
    } // k2.6, Claude-5
    return 'reroute-json'; // always-thinking + forced tool_choice = impossible
}
