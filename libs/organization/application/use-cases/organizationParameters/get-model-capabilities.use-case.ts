import { REGISTRY } from '@libs/llm/providers';
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
        const cfg = {
            provider,
            model: modelId,
            apiKey: '',
        } as ProviderBuildConfig;
        const temperature: TemperaturePolicy =
            providerModule.temperaturePolicy?.(cfg) ??
            ((caps.supportsTemperature ?? true)
                ? { kind: 'adjustable' }
                : { kind: 'unsupported' });

        const reasoningOptions =
            caps.reasoningConfig &&
            (caps.reasoningConfig.type === 'level' ||
                caps.reasoningConfig.type === 'adaptive')
                ? caps.reasoningConfig.options
                : [];

        return {
            temperature,
            supportsReasoning: caps.supportsReasoning ?? false,
            reasoningOptions,
            reasoningOverrideExample:
                providerModule.reasoningOverrideExample?.(provider),
        };
    }
}
