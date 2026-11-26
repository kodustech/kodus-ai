import { AuthIntegrationEntity } from './auth-integration.entity';

describe('AuthIntegrationEntity', () => {
    it('keeps the workspace a link belongs to, so links of one organization can be told apart', () => {
        const entity = AuthIntegrationEntity.create({
            uuid: 'auth-1',
            status: true,
            organization: { uuid: 'org-1' },
            team: { uuid: 'team-1' },
        });

        expect(entity.team).toEqual({ uuid: 'team-1' });
        expect(entity.organization).toEqual({ uuid: 'org-1' });
    });
});
