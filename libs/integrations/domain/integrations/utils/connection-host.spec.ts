import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { connectionServerKey } from './connection-host';

describe('connectionServerKey', () => {
    it.each([
        [PlatformType.GITHUB, {}, 'GITHUB|github.com'],
        [
            PlatformType.GITHUB,
            { host: 'https://GHE.acme.io/' },
            'GITHUB|ghe.acme.io',
        ],
        [PlatformType.GITLAB, {}, 'GITLAB|gitlab.com'],
        [
            PlatformType.GITLAB,
            { host: 'https://git.acme.io' },
            'GITLAB|git.acme.io',
        ],
        [PlatformType.BITBUCKET, {}, 'BITBUCKET|bitbucket.org'],
        [
            PlatformType.BITBUCKET,
            { host: 'bb.acme.io' },
            'BITBUCKET|bb.acme.io',
        ],
        [
            PlatformType.FORGEJO,
            { host: 'https://code.acme.io' },
            'FORGEJO|code.acme.io',
        ],
        [
            PlatformType.AZURE_REPOS,
            { orgUrl: 'https://dev.azure.com/acme' },
            'AZURE_REPOS|dev.azure.com',
        ],
    ])('names the server of a %s connection', (platform, authDetails, key) => {
        expect(connectionServerKey(platform, authDetails)).toBe(key);
    });
});
