import { REGISTRY } from '@libs/llm/providers';
import type { ProviderBuildConfig } from '@libs/llm/providers/kernel/types';
import { ProviderService } from '@libs/core/infrastructure/services/providers/provider.service';
import { BadRequestException, Injectable } from '@nestjs/common';

/**
 * The per-model capability hints the BYOK connect form needs to render honest
 * controls — whether to show the Temperature field and whether the model can
 * reason (and at which levels). PROVIDER-OWNED: every value is read from the
 * provider module in the registry (`capabilities(model)` + `supportsSamplingParams`),
 * never hand-coded in the web — so adding/adjusting a model's behavior is a
 * change in ONE place (the provider module the community contributes to), and
 * the UI follows automatically.
 */
export interface ModelUiCapabilities {
    /** Sampling params (temperature/top_p) may be sent. False for models that
     *  reject them (e.g. OpenAI gpt-5 / o-series, Anthropic 4.7+) — the UI hides
     *  the Temperature field so it can't be set to a value the provider 400s on. */
    supportsTemperature: boolean;
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
                supportsTemperature: true,
                supportsReasoning: false,
                reasoningOptions: [],
            };
        }

        const modelId = model ?? '';
        const caps = providerModule.capabilities(modelId);

        // Temperature: the AUTHORITATIVE per-model answer is `supportsSamplingParams`
        // when the module declares it (it knows, per id + model, whether a request
        // carrying temperature 400s — e.g. Anthropic 4.7+, whose capabilities()
        // reports supportsTemperature:true but whose sampling method says false).
        // Otherwise fall back to the static capability flag (OpenAI's path).
        const cfg = {
            provider,
            model: modelId,
            apiKey: '',
        } as ProviderBuildConfig;
        const supportsTemperature = providerModule.supportsSamplingParams
            ? providerModule.supportsSamplingParams(cfg)
            : (caps.supportsTemperature ?? true);

        const reasoningOptions =
            caps.reasoningConfig &&
            (caps.reasoningConfig.type === 'level' ||
                caps.reasoningConfig.type === 'adaptive')
                ? caps.reasoningConfig.options
                : [];

        return {
            supportsTemperature,
            supportsReasoning: caps.supportsReasoning ?? false,
            reasoningOptions,
            reasoningOverrideExample:
                providerModule.reasoningOverrideExample?.(provider),
        };
    }
}
