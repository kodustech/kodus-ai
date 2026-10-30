import { encrypt } from '@libs/common/utils/crypto';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { GithubService } from './github.service';

/**
 * GraphQL endpoint for GitHub Enterprise Server PAT integrations.
 * @octokit/graphql maps a GHES REST base (`<host>/api/v3`) to
 * `<host>/api/graphql`; any other base gets `/graphql` appended. Passing
 * `<host>/api/graphql` therefore sent every call (review threads, minimizing
 * outdated comments, ...) to `<host>/api/graphql/graphql`, a 404.
 */
describe('GithubService.instanceGraphQL — GitHub Enterprise Server endpoint', () => {
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
        fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({ data: { viewer: { login: 'kody' } } }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                },
            ),
        );
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    function createService(authDetails: Record<string, unknown>): any {
        const svc: any = Object.create(GithubService.prototype);
        svc.getGithubAuthDetails = jest.fn().mockResolvedValue(authDetails);
        return svc;
    }

    const organizationAndTeamData = { organizationId: 'o1', teamId: 't1' };

    it('sends GraphQL calls of a GHES PAT integration to <host>/api/graphql', async () => {
        const svc = createService({
            authMode: AuthMode.TOKEN,
            authToken: encrypt('ghp_test'),
            host: 'https://ghe.example.com/',
        });

        const graphqlClient = await svc.instanceGraphQL(
            organizationAndTeamData,
        );
        await graphqlClient('query { viewer { login } }');

        const [url, init] = fetchSpy.mock.calls[0];
        expect(String(url)).toBe('https://ghe.example.com/api/graphql');
        expect(init.headers.authorization).toBe('token ghp_test');
    });

    it('keeps github.com PAT integrations on the public endpoint', async () => {
        const svc = createService({
            authMode: AuthMode.TOKEN,
            authToken: encrypt('ghp_test'),
        });

        const graphqlClient = await svc.instanceGraphQL(
            organizationAndTeamData,
        );
        await graphqlClient('query { viewer { login } }');

        expect(String(fetchSpy.mock.calls[0][0])).toBe(
            'https://api.github.com/graphql',
        );
    });
});
