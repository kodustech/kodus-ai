import {
    filterVisibleReviewLabels,
    mergeMissingReviewOptions,
} from '../../../apps/web/src/app/(app)/settings/code-review/[repositoryId]/general/_utils/review-options-state';
import { FormattedConfigLevel } from '../../../apps/web/src/app/(app)/settings/code-review/_types';

describe('mergeMissingReviewOptions', () => {
    it('adds missing labels without overwriting existing values', () => {
        expect(
            mergeMissingReviewOptions(
                {
                    bug: {
                        value: true,
                        level: FormattedConfigLevel.GLOBAL,
                    },
                },
                ['bug', 'performance', 'security'],
            ),
        ).toEqual({
            bug: {
                value: true,
                level: FormattedConfigLevel.GLOBAL,
            },
            performance: {
                value: false,
                level: FormattedConfigLevel.DEFAULT,
            },
            security: {
                value: false,
                level: FormattedConfigLevel.DEFAULT,
            },
        });
    });

    it('returns the same object reference when nothing is missing', () => {
        const current = {
            bug: {
                value: true,
                level: FormattedConfigLevel.GLOBAL,
            },
            performance: {
                value: false,
                level: FormattedConfigLevel.DEFAULT,
            },
        };

        expect(mergeMissingReviewOptions(current, ['bug', 'performance'])).toBe(
            current,
        );
    });

    it('filters business logic labels when the feature flag is disabled', () => {
        expect(
            filterVisibleReviewLabels(
                [
                    {
                        type: 'bug',
                        name: 'Bug',
                        description: 'Bug checks',
                    },
                    {
                        type: 'business_logic',
                        name: 'Business Logic',
                        description: 'Business rules',
                    },
                ],
                false,
            ),
        ).toEqual([
            {
                type: 'bug',
                name: 'Bug',
                description: 'Bug checks',
            },
        ]);
    });
});
