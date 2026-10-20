import { resolveAgentReviewSettings } from './agent-review-settings';
import { resolveAdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';
import { resolveContextWindow } from '@libs/llm/model-context-window';

describe('resolveAgentReviewSettings', () => {
    it('runs every category when the team set none, on the default window', () => {
        const s = resolveAgentReviewSettings(undefined);
        expect(s.reviewOptions).toEqual({ bug: true, security: true, performance: true });
        expect(s.effectiveContextWindow).toBe(resolveContextWindow({ modelName: '' }));
        expect(s.adaptiveProfile).toEqual(resolveAdaptiveProfile(s.effectiveContextWindow));
    });

    it("keeps the team's categories", () => {
        const options = { bug: true, security: false, performance: false };
        expect(resolveAgentReviewSettings({ reviewOptions: options } as any).reviewOptions).toBe(options);
    });

    it("sizes the profile on the routed slot's own input limit", () => {
        const s = resolveAgentReviewSettings({ resolvedModelSlot: { provider: 'openai', model: 'gpt-x', maxInputTokens: 16000 } } as any);
        expect(s.effectiveContextWindow).toBe(16000);
        expect(s.adaptiveProfile).toEqual(resolveAdaptiveProfile(16000));
        expect(s.effectiveModelName).toBe('openai:gpt-x');
    });

    it('applies the legacy model NAME only when no model id is set', () => {
        const slot = { provider: 'openai', model: 'gpt-x' };
        expect(resolveAgentReviewSettings({ resolvedModelSlot: slot, byokModel: 'gpt-y' } as any).effectiveModelName).toBe('openai:gpt-y');
        expect(resolveAgentReviewSettings({ resolvedModelSlot: slot, byokModel: 'gpt-y', byokModelId: 'm1' } as any).effectiveModelName).toBe('openai:gpt-x');
    });
});
