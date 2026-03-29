import {
    countConfigOverridesByRoute,
    countConfigOverridesForRoutes,
} from '../../../apps/web/src/app/(app)/settings/_utils/count-overrides';
import { FormattedConfigLevel } from '../../../apps/web/src/app/(app)/settings/code-review/_types';

const formattedValue = (value: unknown, level: FormattedConfigLevel) => ({
    value,
    level,
    overriddenValue: null,
    overriddenLevel: FormattedConfigLevel.DEFAULT,
});

describe('route override counts', () => {
    it('counts only the fields that belong to a specific route', () => {
        const config = {
            automatedReviewActive: formattedValue(
                true,
                FormattedConfigLevel.REPOSITORY,
            ),
            showStatusFeedback: formattedValue(
                false,
                FormattedConfigLevel.REPOSITORY,
            ),
            reviewOptions: {
                bug: formattedValue(true, FormattedConfigLevel.REPOSITORY),
            },
            v2PromptOverrides: {
                review: formattedValue(
                    'custom prompt',
                    FormattedConfigLevel.REPOSITORY,
                ),
            },
        } as any;

        expect(
            countConfigOverridesByRoute(
                config,
                'general',
                FormattedConfigLevel.REPOSITORY,
            ),
        ).toBe(2);
        expect(
            countConfigOverridesByRoute(
                config,
                'review-categories',
                FormattedConfigLevel.REPOSITORY,
            ),
        ).toBe(1);
        expect(
            countConfigOverridesByRoute(
                config,
                'custom-prompts',
                FormattedConfigLevel.REPOSITORY,
            ),
        ).toBe(1);
    });

    it('aggregates unique route prefixes without double counting shared paths', () => {
        const config = {
            automatedReviewActive: formattedValue(
                true,
                FormattedConfigLevel.DIRECTORY,
            ),
            showStatusFeedback: formattedValue(
                false,
                FormattedConfigLevel.DIRECTORY,
            ),
            reviewOptions: {
                bug: formattedValue(true, FormattedConfigLevel.DIRECTORY),
            },
        } as any;

        expect(
            countConfigOverridesForRoutes(
                config,
                ['general', 'general', 'review-categories'],
                FormattedConfigLevel.DIRECTORY,
            ),
        ).toBe(3);
    });
});
