import { REGISTRY } from '@libs/llm/providers';
import { resolveTemperaturePolicy } from '@libs/llm/providers/kernel/temperature';
import type { ProviderBuildConfig } from '@libs/llm/providers/kernel/types';
import type { TemperaturePolicy } from '@libs/llm/providers/kernel/model-types';
import { ProviderService } from '@libs/core/infrastructure/services/providers/provider.service';
import { BadRequestException, Injectable } from '@nestjs/common';

/**
 * The per-model capability hints the BYOK connect form needs to render honest
 * controls — how to render the Temperature field and whether the model can reason
 * (and at which levels). PROVIDER-OWNED: every value is read from the provider
 * module in the registry (`capabilities(model)` + `temperaturePolicy`), never
 * hand-coded in the web — so adding/adjusting a model's behavior is a change in ONE
 * place (the provider module the community contributes to), and the UI follows.
 */
export interface ModelUiCapabilities {
    /** How the Temperature field behaves — `adjustable` (editable), `unsupported`
     *  (hidden; the provider 400s if it's sent — OpenAI gpt-5/o-series, Anthropic
     *  4.7+), or `fixed` (locked to the one sound value — always-thinking
     *  Anthropic-protocol models pin it to 1). One shape, read straight by the form. */
    temperature: TemperaturePolicy;
    /**
     * The temperature policy that applies ONLY when reasoning is turned off, and
     * ONLY when it differs from `temperature` above. Present for the handful of
     * models whose vendor scopes the constraint to thinking MODE rather than to
     * the model — DeepSeek documents "Thinking mode does not support the
     * temperature, top_p, presence_penalty, or frequency_penalty parameters",
     * so the same model accepts one with reasoning off.
     *
     * It travels in the SAME response instead of being a second request with an
     * effort argument: that keeps this endpoint a pure function of
     * (provider, model), so it stays cacheable and flipping the reasoning toggle
     * costs nothing. The client picks between the two; the RULE — which models,
     * in which direction — is still computed here, from the provider module.
     *
     * Absent ⇒ `temperature` applies in both states, which is every other model.
     */
    temperatureWhenReasoningOff?: TemperaturePolicy;
    /** The model can run with a reasoning/thinking budget. */
    supportsReasoning: boolean;
    /** The valid canonical reasoning levels for this model (from the module's
     *  reasoningConfig). Empty when reasoning is unsupported or uses a non-level
     *  (budget) config — the UI then offers the generic effort scale / Custom. */
    reasoningOptions: Array<'low' | 'medium' | 'high'>;
    /** Example JSON for the "Custom" reasoning-override textarea, owned by the
     *  provider module. Undefined ⇒ the UI shows a generic enabled-thinking one. */
    reasoningOverrideExample?: string;
}

@Injectable()
export class GetModelCapabilitiesUseCase {
    constructor(private readonly providerService: ProviderService) {}

    execute(provider: string, model: string): ModelUiCapabilities {
        if (!this.providerService.isProviderSupported(provider)) {
            throw new BadRequestException(`Unsupported provider: ${provider}`);
        }

        // Supported but not registry-backed (defensive) — stay permissive so the
        // form never wrongly hides a field.
        const providerModule = REGISTRY.has(provider)
            ? REGISTRY.get(provider)
            : null;
        if (!providerModule) {
            return {
                temperature: { kind: 'adjustable' },
                supportsReasoning: false,
                reasoningOptions: [],
            };
        }

        const modelId = model ?? '';
        const caps = providerModule.capabilities(modelId);

        // Temperature: the AUTHORITATIVE per-model answer is `temperaturePolicy`
        // when the module declares it (it knows, per id + model, whether temperature
        // 400s, is pinned, or is free — e.g. Anthropic 4.7+ = unsupported, Kimi
        // k2.7-code = fixed at 1). Otherwise derive it from the static capability
        // flag (every provider but Anthropic).
        const policyFor = (reasoningEffort?: string): TemperaturePolicy => {
            const cfg = {
                provider,
                model: modelId,
                apiKey: '',
                ...(reasoningEffort ? { reasoningEffort } : {}),
            } as ProviderBuildConfig;
            return resolveTemperaturePolicy(providerModule, cfg);
        };

        // Asked TWICE, on purpose, and answered in one response. Some constraints
        // are scoped to thinking being ON rather than to the model, so the honest
        // answer differs by reasoning state — but making the caller send the state
        // would turn this into an impure, per-toggle request and throw away the
        // cacheability that makes a capabilities endpoint worth having. Computing
        // both here costs one extra pure function call.
        const temperature = policyFor();
        const whenReasoningOff = policyFor('none');
        const temperatureWhenReasoningOff =
            JSON.stringify(whenReasoningOff) === JSON.stringify(temperature)
                ? undefined
                : whenReasoningOff;

        const reasoningOptions =
            caps.reasoningConfig &&
            (caps.reasoningConfig.type === 'level' ||
                caps.reasoningConfig.type === 'adaptive')
                ? caps.reasoningConfig.options
                : [];

        return {
            temperature,
            ...(temperatureWhenReasoningOff
                ? { temperatureWhenReasoningOff }
                : {}),
            supportsReasoning: caps.supportsReasoning ?? false,
            reasoningOptions,
            reasoningOverrideExample: providerModule.reasoningOverrideExample?.(
                provider,
                modelId,
            ),
        };
    }
}
