/**
 * anthropic module — reasoning off, capability declarations, the OpenCode Go
 * session header, and Claude ids proxied over anthropic_compatible. Usage
 * normalization is shared by every module and proven once in
 * kernel/conformance.spec.ts + kernel/registry.spec.ts (A1: the anthropic SDK
 * folds thinking into output_tokens, so reasoning surfaces as 0).
 */
import { anthropicModule } from './index';
import {
    compatibleTemperaturePolicy,
    planStructuredCall,
    resolveCompatibleReasoningTraits,
} from '../kernel/reasoning-traits';

// A minimal build config; apiKey/baseURL are never dialed.
const anthropicNativeCfg = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    apiKey: 'test-key',
} as any;

describe('anthropicModule.reasoning — effort=none owns "thinking off"', () => {
    const off = (model: string, provider = 'anthropic') =>
        anthropicModule.reasoning!(
            { provider, model, apiKey: '' } as any,
            'none',
        );

    it('says `disabled` out loud on models that think by default (Opus 5)', () => {
        expect(off('claude-opus-5')).toEqual({
            anthropic: { thinking: { type: 'disabled' } },
        });
    });

    it('omits the config on legacy models (never think unasked)', () => {
        expect(off('claude-sonnet-4-5')).toEqual({});
    });

    it('leaves Fable thinking on — the API rejects `disabled`', () => {
        expect(off('claude-fable-5')).toEqual({});
    });

    it('says `disabled` out loud on DISABLE-able compatible models (Kimi K2.6)', () => {
        // K2.5/K2.6 enable thinking by DEFAULT and accept `{ type: 'disabled' }`.
        // Omitting it left thinking ON, which 400s a forced-tool_choice call —
        // the PR#144/#145/#146 Kody Rules failure. "Off" must be explicit.
        expect(off('kimi-k2.6', 'anthropic_compatible')).toEqual({
            anthropic: { thinking: { type: 'disabled' } },
        });
    });

    it('OMITS the config on ALWAYS-thinking compatible models (Kimi k2.7-code, k3 — no disable)', () => {
        // k2.7-code and k3 think permanently and expose no disable — sending
        // `{ type: 'disabled' }` is invalid. Omitting IS the only "off"; the
        // structured executor reroutes these to json (no forced tool_choice).
        expect(off('kimi-k2.7-code', 'anthropic_compatible')).toEqual({});
        expect(off('kimi-k3', 'anthropic_compatible')).toEqual({});
    });
});

describe('anthropicModule capability ↔ behavior (D-05)', () => {
    it("declares structuredOutput 'none' — anthropic does structured output via tool use", () => {
        expect(
            anthropicModule.capabilities(anthropicNativeCfg.model)
                .structuredOutput,
        ).toBe('none');
    });
});

describe('anthropicModule x-opencode-session header (issue #1880 — OpenCode Go also exposes /v1/messages)', () => {
    const HEX32 = /^[0-9a-f]{32}$/;

    it('anthropic_compatible pointed at opencode.ai/zen gets the header', () => {
        const model = anthropicModule.build({
            provider: 'anthropic_compatible',
            model: 'claude-sonnet-4-5-20250929',
            apiKey: 'test-key',
            baseURL: 'https://opencode.ai/zen/go',
            byokModelId: 'model-123',
        } as any) as any;

        expect(model.config.headers()['x-opencode-session']).toMatch(HEX32);
    });

    it('native anthropic pointed at opencode.ai/zen gets the header too (it also accepts a baseURL override)', () => {
        const model = anthropicModule.build({
            provider: 'anthropic',
            model: 'claude-sonnet-4-5-20250929',
            apiKey: 'test-key',
            baseURL: 'https://opencode.ai/zen/go/v1',
            byokModelId: 'model-123',
        } as any) as any;

        expect(model.config.headers()['x-opencode-session']).toMatch(HEX32);
    });

    it('neither branch gets the header for a normal Anthropic/compatible baseURL', () => {
        const compatible = anthropicModule.build({
            provider: 'anthropic_compatible',
            model: 'claude-sonnet-4-5-20250929',
            apiKey: 'test-key',
            baseURL: 'https://api.moonshot.ai/v1',
            byokModelId: 'model-123',
        } as any) as any;
        expect(compatible.config.headers()).not.toHaveProperty(
            'x-opencode-session',
        );

        const native = anthropicModule.build(anthropicNativeCfg) as any;
        expect(native.config.headers()).not.toHaveProperty(
            'x-opencode-session',
        );
    });
});

describe('anthropicModule — a Claude id proxied over anthropic_compatible (#2125)', () => {
    const cfg = (model: string, provider = 'anthropic_compatible') =>
        ({ provider, model, apiKey: '' }) as any;

    it('takes the native Claude traits, so structured calls never force tool_choice on Opus 5.5', () => {
        const traits = anthropicModule.reasoningTraits!(cfg('claude-opus-5-5'));

        expect(traits).toEqual(
            anthropicModule.reasoningTraits!(
                cfg('claude-opus-5-5', 'anthropic'),
            ),
        );
        // Opus 5.5 rejects both `disabled` thinking and a forced tool_choice:
        // the unknown-upstream default planned `suppress-thinking` here.
        expect(planStructuredCall('none', traits)).toBe('reroute-json');
    });

    it('withholds temperature from a Claude that rejects it', () => {
        expect(
            anthropicModule.temperaturePolicy!(cfg('claude-opus-5-5')),
        ).toEqual({ kind: 'unsupported' });
    });

    it('keeps temperature for a Claude that still accepts it', () => {
        expect(
            anthropicModule.temperaturePolicy!(cfg('claude-sonnet-4-5')),
        ).toEqual({ kind: 'adjustable' });
    });

    it('turns reasoning off the way native Claude does', () => {
        for (const model of [
            'claude-opus-5-5',
            'claude-fable-5',
            'claude-sonnet-4-5',
            'claude-opus-5',
        ]) {
            expect(
                anthropicModule.reasoning!(cfg(model), 'none'),
            ).toEqual(
                anthropicModule.reasoning!(cfg(model, 'anthropic'), 'none'),
            );
        }
    });

    it('leaves non-Claude compatible ids on the compatible table', () => {
        expect(anthropicModule.reasoningTraits!(cfg('kimi-k2.6'))).toEqual(
            resolveCompatibleReasoningTraits('kimi-k2.6'),
        );
        expect(anthropicModule.temperaturePolicy!(cfg('kimi-k2.6'))).toEqual(
            compatibleTemperaturePolicy('kimi-k2.6', undefined),
        );
    });
});
