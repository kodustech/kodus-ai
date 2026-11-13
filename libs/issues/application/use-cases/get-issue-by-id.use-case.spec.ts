import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IssueSource } from '@libs/issues/domain/interfaces/issues.interface';

import { GetIssueByIdUseCase } from './get-issue-by-id.use-case';

function useCaseFor(
    issue: Record<string, unknown>,
    httpUrl = 'https://dev.azure.com/acme/shop/_git/shop',
    configs?: unknown[],
) {
    return new GetIssueByIdUseCase(
        { findById: jest.fn(async () => issue) } as any,
        { getByOrganizationId: jest.fn(async () => []) } as any,
        {
            enrichContributingSuggestions: jest.fn(async () => []),
            ageCalculation: jest.fn(async () => '1 day'),
        } as any,
        {
            // Azure links are built from the repository's http_url, as the
            // issue's organization lists it on the issue's platform.
            findByOrganizationAndConfigKey: jest.fn(async (organizationId: string) =>
                organizationId !== 'org-1'
                    ? []
                    : (configs ?? [
                          {
                              integration: { platform: (issue as any).repository.platform },
                              configValue: [{ id: 'repo-1', http_url: httpUrl }],
                          },
                      ]),
            ),
        } as any,
        { user: { uuid: 'u-1', organization: { uuid: 'org-1' } } } as any,
        { ensure: jest.fn(async () => undefined) } as any,
    );
}

const base = {
    uuid: 'i-1',
    organizationId: 'org-1',
    title: 'IDOR',
    filePath: 'src/orders.controller.ts',
    contributingSuggestions: [],
    repository: {
        id: 'repo-1',
        name: 'shop',
        full_name: 'acme/shop',
        platform: PlatformType.GITHUB,
        url: 'https://github.com/acme/shop',
    },
};

describe('GetIssueByIdUseCase — file link', () => {
    it('links a scan finding to the commit its last scan read, not to main', async () => {
        const details = await useCaseFor({
            ...base,
            source: IssueSource.SECURITY_SCAN,
            lastSeenCommitSha: 'abc123',
        }).execute('i-1');

        expect(details?.fileLink.url).toBe(
            'https://github.com/acme/shop/blob/abc123/src/orders.controller.ts',
        );
    });

    it('keeps the main link for a review issue', async () => {
        const details = await useCaseFor({
            ...base,
            lastSeenCommitSha: 'abc123',
        }).execute('i-1');

        expect(details?.fileLink.url).toBe(
            'https://github.com/acme/shop/blob/main/src/orders.controller.ts',
        );
    });

    it('pins an Azure scan finding link to its commit', async () => {
        const details = await useCaseFor({
            ...base,
            repository: {
                ...base.repository,
                platform: PlatformType.AZURE_REPOS,
            },
            source: IssueSource.SECURITY_SCAN,
            lastSeenCommitSha: 'abc123',
        }).execute('i-1');

        expect(details?.fileLink.url).toBe(
            'https://dev.azure.com/acme/shop/_git/shop?path=/src/orders.controller.ts&version=GCabc123',
        );
    });

    it('links a Forgejo scan finding to its commit, from the clone URL', async () => {
        const details = await useCaseFor({
            ...base,
            repository: {
                ...base.repository,
                platform: PlatformType.FORGEJO,
                url: undefined,
            },
            source: IssueSource.SECURITY_SCAN,
            lastSeenCommitSha: 'abc123',
        }, 'https://git.acme.dev/acme/shop.git').execute('i-1');

        expect(details?.fileLink.url).toBe(
            'https://git.acme.dev/acme/shop/src/commit/abc123/src/orders.controller.ts',
        );
        expect(details?.repositoryLink.url).toBe('https://git.acme.dev/acme/shop');
    });

    it('takes the URL from the repository on the finding\'s own platform and instance, never another with the same id', async () => {
        const forgejo = { ...base.repository, platform: PlatformType.FORGEJO, url: undefined };
        const listed = (platform: PlatformType, http_url: string) => ({
            integration: { platform },
            configValue: [{ id: 'repo-1', http_url }],
        });
        const details = await useCaseFor(
            {
                ...base,
                repository: { ...forgejo, host: 'git.acme.dev' },
                source: IssueSource.SECURITY_SCAN,
                lastSeenCommitSha: 'abc123',
            },
            undefined,
            [
                listed(PlatformType.AZURE_REPOS, 'https://dev.azure.com/other/x/_git/x'),
                listed(PlatformType.FORGEJO, 'https://git.private.io/secret/repo.git'),
                listed(PlatformType.FORGEJO, 'https://git.acme.dev/acme/shop.git'),
            ],
        ).execute('i-1');

        expect(details?.repositoryLink.url).toBe('https://git.acme.dev/acme/shop');
    });

    it.each([PlatformType.AZURE_REPOS, PlatformType.FORGEJO])(
        'still shows a %s issue whose repository URL cannot be read, without a broken link',
        async (platform) => {
            const useCase = useCaseFor({
                ...base,
                repository: { ...base.repository, platform, url: undefined },
                contributingSuggestions: [{ id: 's-1', prNumber: 7 }],
            });
            (useCase as any).integrationConfigService.findByOrganizationAndConfigKey = jest.fn(async () => {
                throw new Error('postgres down');
            });
            (useCase as any).kodyIssuesManagementService.enrichContributingSuggestions = jest.fn(async () => []);

            const details = await useCase.execute('i-1');

            expect(details?.id).toBe('i-1');
            expect(details?.fileLink.url).toBe('');
            expect(details?.repositoryLink.url).toBe('');
            expect(details?.prLinks).toEqual([{ label: '7', url: '' }]);
        },
    );

    it("keeps the issue's own URL when the configured one cannot be read", async () => {
        const useCase = useCaseFor({
            ...base,
            repository: {
                ...base.repository,
                platform: PlatformType.AZURE_REPOS,
                url: 'https://dev.azure.com/acme/shop/_git/shop',
            },
            source: IssueSource.SECURITY_SCAN,
            lastSeenCommitSha: 'abc123',
        });
        (useCase as any).integrationConfigService.findByOrganizationAndConfigKey = jest.fn(async () => {
            throw new Error('postgres down');
        });

        const details = await useCase.execute('i-1');

        expect(details?.fileLink.url).toBe(
            'https://dev.azure.com/acme/shop/_git/shop?path=/src/orders.controller.ts&version=GCabc123',
        );
    });
});
