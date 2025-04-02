import { IMappedPlatform } from '@/core/domain/platformIntegrations/types/webhooks/webhooks-common.type';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { GithubMappedPlatform } from './github';
import { GitlabMappedPlatform } from './gitlab';
import { BitbucketMappedPlatform } from './bitbucket';

const platformMaps = new Map<PlatformType, IMappedPlatform>([
    [PlatformType.GITHUB, new GithubMappedPlatform()],
    [PlatformType.GITLAB, new GitlabMappedPlatform()],
    [PlatformType.BITBUCKET, new BitbucketMappedPlatform()],
] as Iterable<readonly [PlatformType, IMappedPlatform]>);

export const getMappedPlatform = (platformType: PlatformType) => {
    return platformMaps.get(platformType);
};
