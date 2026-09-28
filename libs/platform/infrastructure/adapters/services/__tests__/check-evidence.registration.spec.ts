import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { AzureReposService } from '../azureRepos/azureRepos.service';
import { BitbucketService } from '../bitbucket.service';
import { ForgejoService } from '../forgejo.service';
import { GithubService } from '../github/github.service';
import { GitlabService } from '../gitlab.service';

/**
 * CodeManagementService.getCheckEvidence resolves the service registered for
 * the platform and returns [] when that object has no `getCheckEvidence`
 * method — no error, no warning. A provider whose registered class omits it
 * therefore loses CI evidence silently, which is exactly what happened to
 * Bitbucket: the implementation lived on BitbucketCloudService while the
 * class actually registered for PlatformType.BITBUCKET is the BitbucketService
 * dispatcher, which did not forward the call.
 *
 * These are the classes carrying @IntegrationServiceDecorator(..., 'codeManagement').
 */
describe('registered code management services expose getCheckEvidence', () => {
    const registered: Array<[PlatformType, { prototype: object }]> = [
        [PlatformType.GITHUB, GithubService],
        [PlatformType.GITLAB, GitlabService],
        [PlatformType.BITBUCKET, BitbucketService],
        [PlatformType.AZURE_REPOS, AzureReposService],
        [PlatformType.FORGEJO, ForgejoService],
    ];

    it.each(registered)('%s implements getCheckEvidence', (_platform, cls) => {
        expect(
            typeof (cls.prototype as Record<string, unknown>).getCheckEvidence,
        ).toBe('function');
    });
});

/**
 * `getFilePatches` recovers hunks a host withheld. Only two hosts need it,
 * and the reason each other host does NOT is worth pinning down: the facade
 * treats a missing method as "nothing to recover", so an implementation added
 * to the wrong class would be silently unreachable — exactly how Bitbucket's
 * `getCheckEvidence` was lost.
 *
 *   GitHub  — `pulls.listFiles` and `compare` both drop `patch` past a size
 *             cap; the raw diff media type does not.
 *   GitLab  — `/diffs` serves a collapsed, size-limited view; reading the raw
 *             diffs bypasses it.
 *   Bitbucket — already fetches a per-file raw diff, which is not capped.
 *   Azure   — builds its patches locally with `createTwoFilesPatch`, so no
 *             API limit applies.
 */
describe('which hosts recover withheld file patches', () => {
    const implemented: Array<[PlatformType, { prototype: object }]> = [
        [PlatformType.GITHUB, GithubService],
        [PlatformType.GITLAB, GitlabService],
    ];

    const notNeeded: Array<[PlatformType, { prototype: object }]> = [
        [PlatformType.BITBUCKET, BitbucketService],
        [PlatformType.AZURE_REPOS, AzureReposService],
        [PlatformType.FORGEJO, ForgejoService],
    ];

    it.each(implemented)('%s implements getFilePatches', (_platform, cls) => {
        expect(
            typeof (cls.prototype as Record<string, unknown>).getFilePatches,
        ).toBe('function');
    });

    it.each(notNeeded)(
        '%s deliberately does not, and the facade degrades to no recovery',
        (_platform, cls) => {
            expect(
                typeof (cls.prototype as Record<string, unknown>)
                    .getFilePatches,
            ).toBe('undefined');
        },
    );
});
