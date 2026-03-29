import { TEAM_STATUS } from '../../../apps/web/src/core/types';
import { resolveInitialSettingsTeamId } from '../../../apps/web/src/app/(app)/settings/_components/settings-initial-state';

describe('resolveInitialSettingsTeamId', () => {
    const teams = [
        { uuid: 'pending-team', name: 'Pending', status: TEAM_STATUS.PENDING },
        { uuid: 'active-a', name: 'Active A', status: TEAM_STATUS.ACTIVE },
        { uuid: 'active-b', name: 'Active B', status: TEAM_STATUS.ACTIVE },
    ];

    it('prefers the active team from the cookie', () => {
        expect(resolveInitialSettingsTeamId(teams as any, 'active-b')).toBe(
            'active-b',
        );
    });

    it('falls back to the first active team when the cookie is missing or invalid', () => {
        expect(resolveInitialSettingsTeamId(teams as any, undefined)).toBe(
            'active-a',
        );
        expect(resolveInitialSettingsTeamId(teams as any, 'pending-team')).toBe(
            'active-a',
        );
        expect(resolveInitialSettingsTeamId(teams as any, 'unknown')).toBe(
            'active-a',
        );
    });
});
