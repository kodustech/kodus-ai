jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { BitbucketCloudService } from './bitbucket-cloud.service';

/**
 * Reading N files must not cost 2N Bitbucket calls.
 *
 * `getRepositoryContentFile` resolved the branch's head commit with
 * `repositories.listCommits` immediately before every `source.read` — same
 * repository, same ref, same answer, repeated once per file. A pull request
 * with 200 files spent 400 requests where 201 were needed, and Bitbucket
 * replied `429 Too Many Requests`: 67 in three hours of production, every one
 * of them on this single method. That distribution is a loop without spacing,
 * not an abusive tenant.
 *
 * The memo is per (repo, workspace, ref) with a short TTL: long enough to
 * cover one review's file fan-out, short enough that a push landing between
 * reviews is picked up by the next one.
 */

const org = { organizationId: 'org-1', teamId: 'team-1' };

const makeService = (listCommits: jest.Mock, read: jest.Mock) => {
    const service = new BitbucketCloudService(
        { findOne: jest.fn() } as any,
        { createOrUpdateConfig: jest.fn() } as any,
        { findOne: jest.fn() } as any,
        { get: jest.fn() } as any,
    );

    jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
        token: 't',
    });
    jest.spyOn(service as any, 'getRepoById').mockResolvedValue({
        id: 'repo-1',
        workspaceId: 'ws-1',
    });
    jest.spyOn(service as any, 'instanceBitbucketApi').mockReturnValue({
        repositories: { listCommits },
        source: { read },
    });
    (service as any).logger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };

    return service;
};

const commitOk = () =>
    jest.fn().mockResolvedValue({
        data: { values: [{ hash: 'deadbeef' }] },
    });

const readFile = (service: BitbucketCloudService, filename: string) =>
    service.getRepositoryContentFile({
        organizationAndTeamData: org as any,
        repository: { id: 'repo-1', name: 'api' },
        file: { filename },
        pullRequest: { head: { ref: 'feat/x' }, base: { ref: 'main' } },
    } as any);

describe('BitbucketCloudService.getRepositoryContentFile — commit resolution', () => {
    it('resolves the head commit once for many files on the same ref', async () => {
        const listCommits = commitOk();
        const read = jest.fn().mockResolvedValue({ data: 'file bytes' });
        const service = makeService(listCommits, read);

        await readFile(service, 'src/a.ts');
        await readFile(service, 'src/b.ts');
        await readFile(service, 'src/c.ts');

        // One resolution, three reads — the ratio the rate limit cares about.
        expect(listCommits).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledTimes(3);
        expect(read.mock.calls.every((c) => c[0].commit === 'deadbeef')).toBe(
            true,
        );
    });

    it('still returns the file content', async () => {
        const service = makeService(
            commitOk(),
            jest.fn().mockResolvedValue({ data: 'file bytes' }),
        );

        const result = await readFile(service, 'src/a.ts');

        expect(result?.data?.content).toBe('file bytes');
    });

    it('does not memoize a miss, so a later push can still resolve', async () => {
        const listCommits = jest
            .fn()
            .mockResolvedValueOnce({ data: { values: [] } })
            .mockResolvedValueOnce({ data: { values: [{ hash: 'cafe' }] } });
        const read = jest.fn().mockResolvedValue({ data: 'bytes' });
        const service = makeService(listCommits, read);

        expect(await readFile(service, 'src/a.ts')).toBeNull();
        expect(await readFile(service, 'src/a.ts')).not.toBeNull();
        expect(listCommits).toHaveBeenCalledTimes(2);
    });
});
