import { resolveKodyLearningSettings } from './kody-rules/kody-learning-settings';
import {
    buildDefaultGlobalCodeReviewConfig,
    buildNewTeamGlobalCodeReviewConfig,
} from './validateCodeReviewConfigFile';

describe('buildDefaultGlobalCodeReviewConfig', () => {
    it('stores no learning value, so a team created by a self-heal keeps the shipped default (on)', () => {
        const config = buildDefaultGlobalCodeReviewConfig();

        expect(config.configs).toEqual({});
        expect(config.repositories).toEqual([]);
        expect(
            resolveKodyLearningSettings(config, 'any-repo')
                .kodyRulesGeneratorEnabled,
        ).toBe(true);
    });
});

describe('buildNewTeamGlobalCodeReviewConfig', () => {
    it('starts a brand-new team with learning from past reviews off', () => {
        const config = buildNewTeamGlobalCodeReviewConfig();

        expect(config.configs).toEqual({ kodyRulesGeneratorEnabled: false });
        expect(config.repositories).toEqual([]);
        expect(
            resolveKodyLearningSettings(config, 'any-repo')
                .kodyRulesGeneratorEnabled,
        ).toBe(false);
    });

    it('returns a fresh object each time', () => {
        const first = buildNewTeamGlobalCodeReviewConfig();
        first.configs.kodyRulesGeneratorEnabled = true;

        expect(buildNewTeamGlobalCodeReviewConfig().configs).toEqual({
            kodyRulesGeneratorEnabled: false,
        });
    });
});
