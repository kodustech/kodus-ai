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
