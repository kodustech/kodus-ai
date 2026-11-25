jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { ConfigService } from '@nestjs/config';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { GithubService } from './github.service';

// Production 2026-11-09: one organization's 40 approval reason comments queued
// behind each other for ~2 minutes. The throttling plugin keeps its write
// queues per client id (one comment every 3s), and without an id every
// installation in the process shared a single queue.
describe('GithubService — write queue per installation', () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
    });

    it('does not make one installation wait behind another one’s comments', async () => {
        global.fetch = jest.fn(
            async () =>
                new Response(JSON.stringify({ id: 1 }), {
                    status: 201,
                    headers: { 'content-type': 'application/json' },
                }),
        ) as any;
        const cache = {
            getFromCache: jest.fn().mockResolvedValue(null),
            addToCache: jest.fn(),
            removeFromCache: jest.fn(),
        };
        const service = new GithubService(
            {} as any,
            {} as any,
            {} as any,
            cache as any,
            { get: jest.fn() } as unknown as ConfigService,
        );
        jest.spyOn(
            service as any,
            'getInstallationAuthentication',
        ).mockResolvedValue({ token: 't' });
        const client = (installationId: string, organizationId: string) =>
            (service as any).instanceOctokit(
                { organizationId, teamId: 'team' },
                { authMode: AuthMode.OAUTH, installationId, org: 'acme' },
            );
        const [a, b] = await Promise.all([
            client('101', 'org-a'),
            client('202', 'org-b'),
        ]);
        const comment = (octokit: any) =>
            octokit.issues.createComment({
                owner: 'acme',
                repo: 'api',
                issue_number: 1,
                body: 'x',
            });
        const startedAt = Date.now();
        await Promise.all([comment(a), comment(b)]);

        // A shared queue posts b's comment 3s after a's.
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(global.fetch).toHaveBeenCalledTimes(2);
    }, 15_000);
});
