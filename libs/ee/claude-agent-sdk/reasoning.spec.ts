import { buildProviderOptions } from '@libs/llm/reasoning-options';

import { cliReasoning } from './reasoning';

// The providerOptions come from the same builder the AI SDK path uses, so the
// SDK path reasons exactly as hard as today's call for the same slot.
const po = (byokProvider: string, modelName: string, effort: any) => buildProviderOptions('t', undefined, { reasoningEffort: effort, byokProvider, modelName });

describe('cliReasoning', () => {
    it.each([
        ['anthropic', 'claude-sonnet-5-5'],
        ['google_vertex', 'claude-sonnet-5-5'],
        ['amazon_bedrock', 'us.anthropic.claude-sonnet-5-5-v1:0'],
        ['open_router', 'anthropic/claude-sonnet-5.5'],
        ['anthropic_compatible', 'claude-opus-5'],
    ])('%s %s: adaptive thinking at the slot effort, and off when the call sends none', (provider, model) => {
        for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
            expect(cliReasoning(po(provider, model, effort))).toEqual({ thinking: { type: 'adaptive' }, effort });
        }
        expect(cliReasoning(po(provider, model, 'none'))).toEqual({ thinking: { type: 'disabled' } });
    });

    it('keeps a budgeted thinking model on its budget', () => {
        expect(cliReasoning(po('anthropic', 'claude-haiku-4-5', 'medium'))).toEqual({ thinking: { type: 'enabled', budgetTokens: 15000 } });
    });

    it('honors an explicit disable and an empty or missing providerOptions', () => {
        expect(cliReasoning({ anthropic: { thinking: { type: 'disabled' } } })).toEqual({ thinking: { type: 'disabled' } });
        expect(cliReasoning({})).toEqual({ thinking: { type: 'disabled' } });
        expect(cliReasoning(undefined)).toEqual({ thinking: { type: 'disabled' } });
    });

    it('drops an effort the CLI does not know instead of guessing', () => {
        expect(cliReasoning({ anthropic: { thinking: { type: 'adaptive' }, effort: 'extreme' } })).toEqual({ thinking: { type: 'adaptive' } });
    });
});
