import { resolveKodyLearningSettings } from './kody-rules/kody-learning-settings';
import { buildDefaultGlobalCodeReviewConfig } from './validateCodeReviewConfigFile';

describe('buildDefaultGlobalCodeReviewConfig', () => {
    it('starts a new team with learning from past reviews off', () => {
        const config = buildDefaultGlobalCodeReviewConfig();

        expect(config.configs).toEqual({ kodyRulesGeneratorEnabled: false });
        expect(config.repositories).toEqual([]);
        expect(
            resolveKodyLearningSettings(config, 'any-repo')
                .kodyRulesGeneratorEnabled,
        ).toBe(false);
    });

    it('returns a fresh object each time', () => {
        const first = buildDefaultGlobalCodeReviewConfig();
        first.configs.kodyRulesGeneratorEnabled = true;

        expect(buildDefaultGlobalCodeReviewConfig().configs).toEqual({
            kodyRulesGeneratorEnabled: false,
        });
    });
});
