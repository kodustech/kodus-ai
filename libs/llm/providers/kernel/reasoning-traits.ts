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

import type { ReasoningConfig } from './model-types';
import { detectModelFamily } from './model-family';

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
    /** The brand accepts a top-level `reasoning_effort` ALONGSIDE its `thinking`
     *  toggle. The brands disagree HARD here and it is NOT inferable from the
     *  transport, which is why this is a per-model fact and not an
     *  `if (provider === 'openai_compatible')`:
     *    - DeepSeek REQUIRES both together (api-docs.deepseek.com/guides/thinking_mode)
     *    - Z.ai/GLM accepts both (docs.z.ai/api-reference/llm/chat-completion)
     *    - Moonshot/Kimi REJECTS the pair outright:
     *      "cannot specify both 'thinking' and 'reasoning_effort'"
     *  Absent ⇒ false ⇒ send the thinking toggle only, the shape every brand takes. */
    acceptsEffortWithThinking?: boolean;
    /**
     * WHICH parameter expresses reasoning on this brand. The two are not
     * interchangeable and the difference is not inferable from the transport:
     *
     *   'thinking-toggle' → a `thinking` object turns it on/off (Kimi, GLM,
     *                       DeepSeek, Claude). `acceptsEffortWithThinking` then
     *                       says whether an effort may ride ALONGSIDE it.
     *   'effort-only'     → there is NO thinking parameter; the brand takes a
     *                       `reasoning_effort` and nothing else (MiniMax M2).
     *                       Sending a `thinking` object to one of these is a
     *                       field it does not have.
     *
     * Absent ⇒ 'thinking-toggle', which is what every brand in the table did
     * before this existed, so nothing changes for them.
     */
    reasoningControl?: 'thinking-toggle' | 'effort-only';
    /** The effort vocabulary the brand actually implements. DeepSeek and GLM use
     *  low/high/max and do NOT accept "medium"; our 4-value scale is mapped into
     *  it by {@link compatibleEffortValue}. Absent ⇒ our own vocabulary. */
    effortScale?: 'low-high-max';
    /** The endpoint FIXES temperature to 1 while thinking, so 1 is the model's
     *  only sound value. This is a PROTOCOL fact, declared rather than inferred:
     *  it used to be derived from `thinksByDefault && !canDisableThinking`, and
     *  that proxy is wrong. "Cannot turn thinking off" and "temperature is
     *  pinned" are different claims — MiniMax M2 is the counterexample, an
     *  always-reasoning model on the OpenAI protocol with no documented
     *  temperature constraint. Deriving the pin from the proxy silently
     *  overrode the configured temperature on 18 production slots.
     *  Absent ⇒ no pin. */
    pinsTemperatureWhileThinking?: boolean;
    /** The vendor states this model's temperature CANNOT be changed and should
     *  not be sent. Distinct from the pin above: a pin says "1 is the only sound
     *  value" and sends 1; this says the field has no effect at all, so sending
     *  anything — including 1 — is noise the user cannot see through.
     *  Also distinct from `rejectsSamplingWhileThinking`, which is scoped to
     *  thinking being ON; this is a property of the model in every mode.
     *  Source required, per model: platform.kimi.ai states it for k2.6
     *  ("temperature is not modifiable, so no need to set it") and k2.7-code
     *  ("temperature is not modifiable and thinking is always on; neither needs
     *  to be set"). Absent ⇒ no claim. */
    temperatureNotModifiable?: boolean;
    /** The endpoint does not SUPPORT sampling params (temperature, top_p,
     *  presence/frequency_penalty) while thinking is active, so they must be
     *  OMITTED. DeepSeek: "Thinking mode does not support the temperature,
     *  top_p, presence_penalty, or frequency_penalty parameters".
     *
     *  Distinct from a brand that accepts only its DEFAULT value (Kimi) — that is
     *  a pin, expressed through the temperature policy, and it keeps the UI able
     *  to tell the user their value won't apply. Z.ai explicitly still supports
     *  sampling params while thinking. Absent ⇒ false ⇒ temperature is forwarded. */
    rejectsSamplingWhileThinking?: boolean;
    /**
     * Would sending NO reasoning parameter at all turn reasoning OFF on this
     * model? This is the ONE question `defaultReasoningEffortFor` needs, and it
     * is a per-model FACT that cannot be derived:
     *
     *   - Gemini: each model carries a documented default thinking level, so
     *     omitting leaves the model's own (often better) default in force. FALSE.
     *   - Native OpenAI: `reasoning.effort` defaults to medium on gpt-5.5/5.6 but
     *     to NONE on gpt-5.1 — omitting there silently disables reasoning. TRUE.
     *   - Any transport where our own `reasoning(cfg, 'none')` emits an explicit
     *     disable (the openai-compatible brands): omitting means the caller's
     *     'none' default reaches the wire as a disable. TRUE.
     *
     * Absent ⇒ treated as TRUE, the safe side: we impose a family default, which
     * can only cost tokens — never silently switch off reasoning on a model the
     * user picked FOR its reasoning.
     */
    omittingDisablesReasoning?: boolean;
}

/**
 * Translate our `none|low|medium|high` effort into the vocabulary a brand
 * actually implements. Monotone and intent-preserving: the user who picked the
 * top of OUR scale gets the top of THEIRS. `medium` has no counterpart on the
 * low/high/max scale — the vendors fold it into `high` themselves, so we do the
 * same explicitly instead of shipping a value the API rejects.
 */
export function compatibleEffortValue(
    effort: string,
    traits: ModelReasoningTraits,
): string | undefined {
    if (effort === 'none') {
        return undefined;
    }
    if (traits.effortScale !== 'low-high-max') {
        return effort;
    }
    switch (effort) {
        case 'low':
            return 'low';
        case 'medium':
            return 'high';
        case 'high':
            return 'max';
        default:
            return undefined;
    }
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
    const family = detectModelFamily(m);

    // GLM (Z.ai): the API supports tool_choice `auto` ONLY — a forced tool_choice
    // is never accepted, so structured output must reroute to response_format /
    // prompt-schema regardless of thinking. GLM-5.3 also forces thinking on.
    if (family === 'glm') {
        // Bounded to the GLM version token. `includes('5.3')` matched the digits
        // anywhere in the id, so any model whose name happened to carry them was
        // pinned as always-thinking and denied a `thinking: disabled` it accepts.
        const alwaysThinking = /glm-?5[.\-_]?3/.test(m);
        return {
            thinksByDefault: true,
            canDisableThinking: !alwaysThinking,
            supportsForcedToolChoice: false,
            forcedToolChoiceRejectsThinking: true,
            // Unchanged from before this fact was declared: an always-thinking
            // GLM keeps its temperature-1 pin.
            pinsTemperatureWhileThinking: alwaysThinking,
            // docs.z.ai: reasoning_effort accepted (5.3 -> low/high/max; 5.2 folds
            // low/medium into high itself); temperature/top_p keep working while
            // thinking, unlike DeepSeek and Kimi.
            acceptsEffortWithThinking: true,
            effortScale: 'low-high-max',
            rejectsSamplingWhileThinking: false,
        };
    }

    // Kimi (Moonshot): k2.7-code and k3 think ALWAYS and expose no disable; k2.5 /
    // k2.6 default-on but can be disabled with `thinking:{type:'disabled'}`.
    // `^k<digit>` catches the BARE Moonshot ids (`k3`, `k3-256k`, `k2.6`) that
    // api.kimi.com serves — without it they fell through to the unknown-upstream
    // default below, so an always-thinking k3 was reported as canDisableThinking
    // and got sent a `thinking:{type:'disabled'}` it rejects. The branch already
    // INTENDED to cover k3 (see alwaysThinking); it was just unreachable.
    if (family === 'kimi') {
        const alwaysThinking = m.includes('code') || m.includes('k3');
        // Scoped to the two ids platform.kimi.ai actually states it for. k2.5,
        // k2.7 (non-code) and k3 are NOT covered by that page, and inferring the
        // rule onto them from a sibling is the move this table exists to avoid —
        // even though omitting would be the safer guess.
        const temperatureNotModifiable =
            /k2[.\-_]?6/.test(m) || m.includes('code');
        return {
            thinksByDefault: true,
            canDisableThinking: !alwaysThinking,
            temperatureNotModifiable,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: true,
            // Unchanged: k3 / k2.7-code keep their temperature-1 pin.
            pinsTemperatureWhileThinking: alwaysThinking,
            // Moonshot 400s on `thinking` + `reasoning_effort` together
            // ("cannot specify both") - reproduced against the live API in
            // HKUDS/nanobot#3939. `thinking` alone is the ONLY accepted shape.
            // Deliberately NOT `rejectsSamplingWhileThinking`: Kimi rejects
            // non-DEFAULT sampling values, which the always-thinking pin to 1
            // already satisfies while keeping the UI warning intact.
            acceptsEffortWithThinking: false,
        };
    }

    // DeepSeek: thinks by default, can disable (effort 'none'), and — unlike Kimi/
    // Claude — its Anthropic endpoint ACCEPTS a forced tool_choice WITH thinking.
    if (family === 'deepseek') {
        return {
            thinksByDefault: true,
            canDisableThinking: true,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: false,
            // api-docs.deepseek.com: `thinking` is passed together WITH
            // `reasoning_effort` (low/high/max - "medium" is not accepted), and
            // thinking mode does not support temperature / top_p / penalties.
            acceptsEffortWithThinking: true,
            effortScale: 'low-high-max',
            rejectsSamplingWhileThinking: true,
        };
    }

    // MiniMax: an `reasoning_effort` brand with NO thinking toggle at all. It
    // defaults to medium and REJECTS 'none' — so reasoning cannot be turned off
    // here, and "off" has to mean omitting the parameter and living with the
    // brand's own default. Its scale is ours (low/medium/high), so no mapping.
    //
    // Until `reasoningControl` existed this model could not be described: saying
    // `thinksByDefault: true` made every compatible transport emit a `thinking`
    // object MiniMax does not have, so the honest move was to say nothing and let
    // 18 production slots ignore the effort the customer picked.
    // Source: platform.minimaxi.com — chat completion `reasoning_effort`.
    // Split on the VERSION, not on the brand: M2 takes `reasoning_effort`, while
    // M3 announces a `thinking.type` toggle instead. M3 stays at the conservative
    // default below because the one fact we have about it (that it uses a toggle)
    // does not say whether it accepts `disabled` — and guessing that wrong sends
    // a 400 to turn reasoning OFF. A verified fact for M2 does not license an
    // invented one for M3.
    if (family === 'minimax' && /minimax[-_.]?m2/.test(m)) {
        return {
            thinksByDefault: true,
            canDisableThinking: false,
            // OpenAI protocol: a forced tool_choice is accepted, and reasoning
            // does not make it invalid (that rule is Anthropic's).
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: false,
            reasoningControl: 'effort-only',
            // Omitting leaves MiniMax's own default (medium) in force — it does
            // NOT turn reasoning off — so no family default is imposed.
            omittingDisablesReasoning: false,
        };
    }

    // Unknown compatible upstream (a self-hosted Llama/vLLM, a generic proxy, any
    // id we don't recognize). Two DIFFERENT safe defaults, one per consumer:
    //   - `thinksByDefault: false` — we must NOT proactively FORCE a `thinking`
    //     param onto a model we can't confirm reasons (it could 400 on a plain
    //     Llama endpoint). So the reasoning-effort default stays unset and the
    //     caller's own default (usually 'none' → no thinking) decides; a user who
    //     DOES want thinking on their custom model sets the slot effort explicitly.
    //   - the forced-tool_choice traits stay CONSERVATIVE (assume thinking, allow
    //     suppress) — that path only ever SENDS a disable, never forces thinking,
    //     so it can't break a non-reasoning upstream while it protects a reasoning
    //     one. (`planStructuredCall` reads these, not `thinksByDefault`.)
    return {
        thinksByDefault: false,
        canDisableThinking: true,
        supportsForcedToolChoice: true,
        forcedToolChoiceRejectsThinking: true,
    };
}

/**
 * The reasoning CONFIG for a compatible-protocol family — the same answer the
 * anthropic / gemini / openai owners give for theirs, so `reasoningConfigForModel`
 * can dispatch every family instead of three of them.
 *
 * Expressed in OUR effort vocabulary, not the vendor's: `compatibleEffortValue`
 * already translates low/medium/high into a brand's own scale (GLM and DeepSeek
 * run low/high/max), so the picker must offer what the user can choose here.
 *
 * Kimi is the honest outlier — it has no effort scale at all, only a `thinking`
 * toggle, so it offers ONE level. Anything above 'none' means the same request.
 *
 * Sources: docs.z.ai (reasoning_effort), api-docs.deepseek.com (thinking_mode),
 * platform.kimi.ai (thinking-models), platform.minimaxi.com (reasoning_effort).
 */
export function compatibleReasoningConfig(
    model?: string,
): ReasoningConfig | undefined {
    // A family advertises a scale only for the VERSIONS its traits confirm
    // reason. The brand alone is not enough: the MiniMax table validates
    // `reasoning_effort` for M2 and deliberately declines to for M3, and reading
    // only the family put low/medium/high in front of an M3 user while the
    // emitter — which reads the same traits — treated it as a non-thinker and
    // sent nothing. The picker and the request were answering the same question
    // from two places.
    //
    // `thinksByDefault` IS that answer, so it is asked rather than re-derived.
    // Everything already advertised keeps advertising (glm, deepseek, kimi and
    // MiniMax M2/M2.5 all carry it); llama, mimo and qwen already returned
    // undefined and still do.
    if (!resolveCompatibleReasoningTraits(model ?? '')?.thinksByDefault) {
        return undefined;
    }
    switch (detectModelFamily(model)) {
        case 'glm':
        case 'deepseek':
        case 'minimax':
            return { type: 'level', options: ['low', 'medium', 'high'] };
        case 'kimi':
            return { type: 'level', options: ['high'] };
        default:
            return undefined;
    }
}

/**
 * The temperature policy for a compatible-protocol model, DERIVED from its family
 * reasoning traits — a MODEL rule, transport-agnostic. An always-thinking model
 * (Kimi k2.7-code/k3, GLM-5.3) reasons unconditionally and pins temperature to 1
 * while thinking, so 1 is its only sound value; disable-able / non-reasoning ones
 * keep a free temperature. Shared by every transport that can host these models
 * (Anthropic-protocol brands, openai_compatible, Novita) so the same Kimi obeys
 * the same rule on any endpoint. Returns `undefined` for a model with no id so a
 * caller can fall through to its own default.
 */
export function compatibleTemperaturePolicy(
    model?: string,
    effort?: string,
):
    | { kind: 'fixed'; value: number }
    | { kind: 'adjustable' }
    | { kind: 'unsupported' } {
    const t = resolveCompatibleReasoningTraits(model);

    // A brand that does not SUPPORT sampling params WHILE REASONING (DeepSeek)
    // must have the field omitted rather than pinned: an ignored temperature is
    // worse than none, because the value the user set in the UI silently does
    // nothing. But the constraint is scoped to thinking being ON — with thinking
    // explicitly disabled the same endpoint accepts a temperature normally, so
    // withholding it there would take away a setting that does work.
    //
    // `none` is the ONLY state where thinking is definitively off. An UNSET
    // effort falls through to the family default, which is on for a
    // thinks-by-default brand, and a caller that cannot supply an effort at all
    // (the connect form asking what a model supports before anything is picked)
    // must get the conservative answer. So: omit unless we were told 'none'.
    const thinkingExplicitlyOff = effort === 'none';
    if (
        t.rejectsSamplingWhileThinking &&
        t.thinksByDefault &&
        !thinkingExplicitlyOff
    ) {
        return { kind: 'unsupported' };
    }

    // Checked BEFORE the pin, because it is the stronger statement. k2.7-code
    // satisfies both — always-thinking (so the pin fires) and documented as
    // unmodifiable — and the pin would have sent `temperature: 1` to a field the
    // vendor says does nothing. Captured on the wire before this: k2.6 received
    // the user's 0.7 and k2.7-code received a 1, neither of which the model reads.
    if (t.temperatureNotModifiable) {
        return { kind: 'unsupported' };
    }

    // The pin is NOT effort-scoped: k3 / GLM-5.3 expose no off
    // switch, so picking "none" does not actually stop them thinking and 1
    // remains their only sound temperature.
    //
    // Read from the DECLARED fact, not from `!canDisableThinking`. The proxy
    // conflated two different claims and pinned MiniMax M2 — always-reasoning,
    // but on the OpenAI protocol with no documented temperature constraint —
    // overriding the configured value on 18 production slots.
    return t.pinsTemperatureWhileThinking
        ? { kind: 'fixed', value: 1 }
        : { kind: 'adjustable' };
}

/** Whether a compatible-protocol id is a KNOWN reasoning model (Kimi/GLM/DeepSeek)
 *  — the gate for advertising reasoning + applying the family rules on a generic
 *  OpenAI-protocol aggregator (Novita) that also hosts non-reasoning models. */
export function isCompatibleReasoner(model?: string): boolean {
    return resolveCompatibleReasoningTraits(model).thinksByDefault;
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
