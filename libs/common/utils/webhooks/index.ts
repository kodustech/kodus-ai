import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IMappedPlatform } from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-common.type';

import { AzureReposMappedPlatform } from './azureRepos';
import { BitbucketMappedPlatform } from './bitbucket';
import { ForgejoMappedPlatform } from './forgejo';
import { GithubMappedPlatform } from './github';
import { GitlabMappedPlatform } from './gitlab';

export * from './webhooks.utils';
export * from './webhook-source-host';

const platformMaps = new Map<PlatformType, IMappedPlatform>([
    [PlatformType.GITHUB, new GithubMappedPlatform()],
    [PlatformType.GITLAB, new GitlabMappedPlatform()],
    [PlatformType.BITBUCKET, new BitbucketMappedPlatform()],
    [PlatformType.AZURE_REPOS, new AzureReposMappedPlatform()],
    [PlatformType.FORGEJO, new ForgejoMappedPlatform()],
] as Iterable<readonly [PlatformType, IMappedPlatform]>);

export const getMappedPlatform = (platformType: PlatformType) => {
    return platformMaps.get(platformType);
};
