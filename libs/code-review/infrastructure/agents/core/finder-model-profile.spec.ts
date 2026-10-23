import {
    DEFAULT_FINDER_PROFILE,
    finderProfileFor,
    finderRunSettings,
} from './finder-model-profile';

describe('finderProfileFor', () => {
    it.each([
        ['claude-opus-5-5', 'claude-opus'],
        ['us.anthropic.claude-opus-4-8', 'claude-opus'],
        ['anthropic/claude-opus-5.5', 'claude-opus'],
        ['claude-sonnet-5-5', 'claude-sonnet'],
        ['global.anthropic.claude-sonnet-5', 'claude-sonnet'],
        ['gpt-6-sol', 'gpt'],
        ['openai.gpt-5.6-sol', 'gpt'],
        ['openai/gpt-5', 'gpt'],
        ['muse-spark-1.3', 'muse'],
        ['deepseek-v4-flash', 'deepseek'],
        ['accounts/fireworks/models/deepseek-v4-flash', 'deepseek'],
        ['kimi-k2.7-code', 'kimi'],
        ['moonshotai.kimi-k2.5', 'kimi'],
        ['moonshotai/kimi-k2', 'kimi'],
    ])('reads %s as %s', (id, family) => {
        expect(finderProfileFor(id).family).toBe(family);
    });

    it.each([
        'gpt-oss-120b',
        'accounts/fireworks/models/gpt-oss-20b',
        'MiniMax-M3',
        'k3',
        'my-deployment',
        '',
        undefined,
    ])('gives %s the default', (id) => {
        expect(finderProfileFor(id)).toEqual(DEFAULT_FINDER_PROFILE);
    });

    it('keeps the measured settings of each family', () => {
        const settings = (id: string) => {
            const { maxSteps, synthesisRescue } = finderProfileFor(id);
            return { maxSteps, synthesisRescue };
        };
        expect(settings('claude-opus-5-5')).toEqual({ maxSteps: 12, synthesisRescue: false });
        expect(settings('gpt-6-sol')).toEqual({ maxSteps: 12, synthesisRescue: false });
        expect(settings('muse-spark-1.3')).toEqual({ maxSteps: 12, synthesisRescue: true });
        expect(settings('claude-sonnet-5-5')).toEqual({ maxSteps: 12, synthesisRescue: true });
        expect(settings('deepseek-v4-flash')).toEqual({ maxSteps: 'adaptive', synthesisRescue: true });
        expect(settings('kimi-k2.7-code')).toEqual({ maxSteps: 'adaptive', synthesisRescue: true });
        expect(settings('some-new-model')).toEqual({ maxSteps: 12, synthesisRescue: false });
    });
});

describe('finderRunSettings', () => {
    it('caps a fixed-budget family and drops its rescue in normal mode', () => {
        expect(finderRunSettings({ maxSteps: 34 }, 'gpt-6-sol')).toMatchObject({
            maxSteps: 12,
            skipSynthesisRescue: true,
        });
    });

    it("keeps the orchestrator's budget for an adaptive family", () => {
        expect(
            finderRunSettings({ reviewMode: 'normal', maxSteps: 34 }, 'deepseek-v4-flash'),
        ).toMatchObject({ maxSteps: 34, skipSynthesisRescue: false });
    });

    it('never turns on a rescue the caller skipped', () => {
        expect(
            finderRunSettings({ maxSteps: 20, skipSynthesisRescue: true }, 'kimi-k2.7-code'),
        ).toMatchObject({ skipSynthesisRescue: true });
    });

    it('leaves fast and deep reviews as they were', () => {
        for (const reviewMode of ['fast', 'deep'] as const) {
            expect(
                finderRunSettings({ reviewMode, maxSteps: 4 }, 'claude-opus-5-5'),
            ).toEqual({ profile: undefined, maxSteps: 4, skipSynthesisRescue: undefined });
        }
    });

    it('gives the same settings when applied twice (chunked reviews)', () => {
        const once = finderRunSettings({ maxSteps: 30 }, 'claude-sonnet-5-5');
        const twice = finderRunSettings(
            { maxSteps: once.maxSteps, skipSynthesisRescue: once.skipSynthesisRescue },
            'claude-sonnet-5-5',
        );
        expect(twice).toEqual(once);
    });
});
