import {
    buildOverrideRevertState,
    isOverrideValueChanged,
} from '../../../apps/web/src/app/(app)/settings/code-review/_components/override-state';
import {
    FormattedConfigLevel,
    type IFormattedConfigProperty,
} from '../../../apps/web/src/app/(app)/settings/code-review/_types';

describe('override-state', () => {
    it('detects primitive and structured value changes', () => {
        expect(isOverrideValueChanged(true, false)).toBe(true);
        expect(isOverrideValueChanged(['a'], ['a'])).toBe(false);
        expect(isOverrideValueChanged(['a'], ['b'])).toBe(true);
        expect(
            isOverrideValueChanged(
                { enabled: true, values: ['a'] },
                { enabled: true, values: ['a'] },
            ),
        ).toBe(false);
        expect(
            isOverrideValueChanged(
                { enabled: true, values: ['a'] },
                { enabled: false, values: ['a'] },
            ),
        ).toBe(true);
    });

    it('returns the parent state when reverting an existing override', () => {
        const property: IFormattedConfigProperty<boolean> = {
            value: false,
            level: FormattedConfigLevel.REPOSITORY,
            overriddenValue: true,
            overriddenLevel: FormattedConfigLevel.GLOBAL,
        };

        expect(
            buildOverrideRevertState(property, FormattedConfigLevel.REPOSITORY),
        ).toEqual({
            value: true,
            level: FormattedConfigLevel.GLOBAL,
        });
    });

    it('returns the current inherited state when reverting a fresh override', () => {
        const property: IFormattedConfigProperty<string[]> = {
            value: ['main'],
            level: FormattedConfigLevel.GLOBAL,
        };

        expect(
            buildOverrideRevertState(property, FormattedConfigLevel.REPOSITORY),
        ).toEqual({
            value: ['main'],
            level: FormattedConfigLevel.GLOBAL,
        });
    });
});
