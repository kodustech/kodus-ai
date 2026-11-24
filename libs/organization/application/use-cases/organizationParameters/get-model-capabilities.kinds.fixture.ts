/**
 * One `/model-capabilities` answer per kind the production sweep found, keyed
 * by the real production (provider, model) that produces it.
 *
 * Shared by two specs so the web form is rendered with what the API really
 * answers: `get-model-capabilities.prod-shapes.spec.ts` asserts the use case
 * still returns these, and the web `advanced-settings.reasoning-copy.spec.tsx`
 * renders them. (The web spec cannot call the use case itself: the provider
 * SDKs need stream globals jsdom does not have.)
 *
 * `reasoningOverrideExample` is left out on purpose; it is copy owned by the
 * provider module and does not decide which reasoning message the form shows.
 */
import type { ModelUiCapabilities } from './get-model-capabilities.use-case';

export interface CapabilityKind {
    provider: string;
    model: string;
    caps: Omit<ModelUiCapabilities, 'reasoningOverrideExample'>;
}

export const CAPABILITY_KINDS = {
    /** Always reasons, and no level can be sent on this wire. */
    alwaysOn: {
        provider: 'anthropic_compatible',
        model: 'MiniMax-M3',
        caps: {
            temperature: { kind: 'adjustable' },
            supportsReasoning: false,
            reasoningAlwaysOn: true,
            reasoningOptions: [],
        },
    },
    /** No reasoning at all. */
    unsupported: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        caps: {
            temperature: { kind: 'adjustable' },
            supportsReasoning: false,
            reasoningOptions: [],
        },
    },
    /** Reasons, at the levels listed. */
    supportedWithLevels: {
        provider: 'openai',
        model: 'gpt-5.4',
        caps: {
            temperature: { kind: 'unsupported' },
            supportsReasoning: true,
            reasoningOptions: ['medium', 'high'],
        },
    },
    /** A Kimi brand model that always thinks but exposes reasoning (no list
     *  of levels: budget-style), so it is not "always on" for the form. */
    brandAlwaysThinking: {
        provider: 'moonshot',
        model: 'kimi-k3.1-pro',
        caps: {
            temperature: { kind: 'fixed', value: 1 },
            supportsReasoning: true,
            reasoningOptions: [],
        },
    },
} satisfies Record<string, CapabilityKind>;
