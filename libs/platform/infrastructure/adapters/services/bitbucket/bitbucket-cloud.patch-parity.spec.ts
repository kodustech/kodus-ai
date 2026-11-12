jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import * as fs from 'fs';
import * as path from 'path';

import { BitbucketCloudService } from './bitbucket-cloud.service';

/**
 * The patches handed to the review must not change when the listing reads
 * one diff for the whole PR instead of one per file.
 *
 * Each fixture is a real Bitbucket Cloud PR: its diffstat, its whole diff,
 * and the per-file patches this code produced for it, checked once against
 * main's per-file reads. Against main, modified files differ only by the
 * trailing newline (which rendered a phantom numbered line in the hunk
 * view), added and removed files lose the leftover `+++`/`---` header, and
 * renamed files carry their real diff instead of a whole-file addition.
 */

interface Fixture {
    source: string;
    destination: string;
    diffstat: unknown[];
    wholeDiff: string;
    expected: Array<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch: string | null;
    }>;
}

const load = (name: string): Fixture =>
    JSON.parse(
        fs.readFileSync(
            path.join(__dirname, 'fixtures', 'patch-parity', `${name}.json`),
            'utf8',
        ),
    );

function listFiles(fixture: Fixture) {
    const service = new BitbucketCloudService(
        { findOne: jest.fn() } as any,
        { createOrUpdateConfig: jest.fn() } as any,
        { findOne: jest.fn() } as any,
        { get: jest.fn() } as any,
    );
    const getDiff = jest.fn().mockResolvedValue({ data: fixture.wholeDiff });

    jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
        token: 't',
    });
    jest.spyOn(service as any, 'getRepoById').mockResolvedValue({
        id: 'repo-1',
        workspaceId: 'ws-1',
    });
    jest.spyOn(service as any, 'getPaginatedResults').mockResolvedValue(
        fixture.diffstat,
    );
    jest.spyOn(service as any, 'instanceBitbucketApi').mockReturnValue({
        pullrequests: {
            get: jest.fn().mockResolvedValue({
                data: {
                    source: { commit: { hash: fixture.source } },
                    destination: { commit: { hash: fixture.destination } },
                },
            }),
            getDiffStat: jest.fn().mockResolvedValue({
                data: { values: fixture.diffstat },
            }),
        },
        hasNextPage: () => false,
        commits: { getDiff },
        source: { read: jest.fn() },
    });
    (service as any).logger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };

    return {
        getDiff,
        files: service.getFilesByPullRequestId({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            } as any,
            repository: { id: 'repo-1', name: 'web' },
            prNumber: 1,
        }),
    };
}

describe('BitbucketCloudService.getFilesByPullRequestId — patch parity', () => {
    it.each([
        // a path with a space and with " b/", non-ASCII names, a rename with
        // and without edits, a deletion, a binary, a mode-only change, an
        // empty file and a file without a trailing newline
        'edge-cases',
        // 70 modified and 10 added files
        'large',
    ])('%s: same patches from one whole-PR diff', async (name) => {
        const fixture = load(name);
        const { getDiff, files } = listFiles(fixture);

        const result = await files;

        expect(getDiff).toHaveBeenCalledTimes(1);
        expect(
            result?.map(
                ({ filename, status, additions, deletions, patch }) => ({
                    filename,
                    status,
                    additions,
                    deletions,
                    patch,
                }),
            ),
        ).toEqual(fixture.expected);
    });
});
