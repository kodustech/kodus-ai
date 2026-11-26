import { connectionCacheScope } from './connection-cache-scope';

describe('connectionCacheScope', () => {
    it("keys a named connection's answers by the connection", () => {
        expect(
            connectionCacheScope({
                organizationId: 'org-1',
                teamId: 'team-1',
                integrationId: 'gl-b',
            }),
        ).toBe('org-1:gl-b');
    });

    it('keeps the answers of two workspaces of one organization apart when no connection is named', () => {
        const first = connectionCacheScope({
            organizationId: 'org-1',
            teamId: 'team-1',
        });
        const second = connectionCacheScope({
            organizationId: 'org-1',
            teamId: 'team-2',
        });

        expect(first).toBe('org-1:workspace:team-1');
        expect(second).toBe('org-1:workspace:team-2');
    });

    it('still answers without any data', () => {
        expect(connectionCacheScope(undefined)).toBe(
            'no-org:workspace:no-team',
        );
    });
});
