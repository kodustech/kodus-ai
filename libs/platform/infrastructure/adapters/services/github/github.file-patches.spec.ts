import { GithubService } from './github.service';

describe('GithubService — getFilePatches', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const makeService = (get: jest.Mock) => {
        const service = Object.create(GithubService.prototype) as GithubService;

        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });

        jest.spyOn(service, 'getAuthenticatedOctokit').mockResolvedValue({
            rest: { pulls: { get } },
        } as never);

        jest.spyOn(service, 'getGithubAuthDetails').mockResolvedValue({
            org: 'acme',
        } as never);

        return service;
    };

    const diff = [
        'diff --git a/yarn.lock b/yarn.lock',
        '--- a/yarn.lock',
        '+++ b/yarn.lock',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
    ].join('\n');

    it('reads the login of the webhook account object', async () => {
        const get = jest.fn().mockResolvedValue({ data: diff });

        const out = await makeService(get).getFilePatches({
            organizationAndTeamData,
            repository: {
                id: '1',
                name: 'widget-api',
                // The recorded account, as GitHub spells it.
                owner: { login: 'Acme', type: 'Organization' } as never,
            },
            prNumber: 7,
            paths: ['yarn.lock'],
        });

        expect(get).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'Acme',
                repo: 'widget-api',
            }),
        );
        expect(out).toHaveLength(1);
        expect(out[0].path).toBe('yarn.lock');
    });

    it('does not follow a payload owner the integration does not hold', async () => {
        // The payload is not authenticated: an owner outside the recorded
        // account and the saved selection must not steer the token.
        const get = jest.fn().mockResolvedValue({ data: diff });

        await makeService(get).getFilePatches({
            organizationAndTeamData,
            repository: {
                id: '1',
                name: 'widget-api',
                owner: { login: 'webhook-account', type: 'User' } as never,
            },
            prNumber: 7,
            paths: ['yarn.lock'],
        });

        expect(get).toHaveBeenCalledWith(
            expect.objectContaining({ owner: 'acme', repo: 'widget-api' }),
        );
    });

    it('falls back to the integration org when the owner object has no login', async () => {
        const get = jest.fn().mockResolvedValue({ data: diff });
        const service = makeService(get);

        await service.getFilePatches({
            organizationAndTeamData,
            repository: {
                id: '1',
                name: 'widget-api',
                owner: { type: 'Organization' } as never,
            },
            prNumber: 7,
            paths: ['yarn.lock'],
        });

        expect(service.getGithubAuthDetails).toHaveBeenCalled();
        expect(get).toHaveBeenCalledWith(
            expect.objectContaining({ owner: 'acme' }),
        );
    });
});
