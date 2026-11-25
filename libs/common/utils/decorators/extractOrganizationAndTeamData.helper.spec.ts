import { extractOrganizationAndTeamData } from './extractOrganizationAndTeamData.helper';

describe('extractOrganizationAndTeamData (decorators)', () => {
    it('keeps the Git connection a call names', () => {
        expect(
            extractOrganizationAndTeamData([
                {
                    organizationAndTeamData: {
                        organizationId: 'org-1',
                        teamId: 'team-1',
                        integrationId: 'gl-b',
                    },
                },
            ]),
        ).toEqual({
            organizationId: 'org-1',
            teamId: 'team-1',
            integrationId: 'gl-b',
        });
    });

    it('leaves the connection out when the call names none', () => {
        expect(
            extractOrganizationAndTeamData([
                { organizationId: 'org-1', teamId: 'team-1' },
            ]),
        ).toEqual({ organizationId: 'org-1', teamId: 'team-1' });
    });
});
