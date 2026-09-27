import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

/**
 * With no directory config the directory-level read of kodus-config.yml fell
 * through to the repository root and fetched the same file twice per review —
 * doubling the provider calls of the every-2-min approval cron (Bitbucket 429s)
 * and labelling a repository-level file as a DIRECTORY config.
 */
describe('CodeBaseConfigService.getMergedCodeReviewConfigs — kodus-config.yml reads', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const repository = { id: 'repo-1', name: 'my-repo' };

    const buildService = (fileContent: string | null) => {
        const codeManagementService = {
            getTypeIntegration: jest.fn().mockResolvedValue('bitbucket'),
            getRepositoryContentFile: jest
                .fn()
                .mockResolvedValue(
                    fileContent === null
                        ? null
                        : { data: { content: fileContent, encoding: '' } },
                ),
        };

        const service = new CodeBaseConfigService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            codeManagementService as any,
            {} as any,
            {} as any,
            {} as any,
        );

        return { service, codeManagementService };
    };

    const parameter = {
        configs: {},
        repositories: [
            {
                id: 'repo-1',
                name: 'my-repo',
                configs: { kodusConfigFileOverridesWebPreferences: true },
            },
        ],
    } as any;

    it('reads the root file once when the repository has no directory config', async () => {
        const { service, codeManagementService } = buildService(null);

        await service.getMergedCodeReviewConfigs(
            organizationAndTeamData,
            repository,
            parameter,
            'main',
            [],
        );

        expect(
            codeManagementService.getRepositoryContentFile,
        ).toHaveBeenCalledTimes(1);
    });

    it('labels a root kodus-config.yml as repository-level, not directory-level', async () => {
        const { service } = buildService(
            'summary:\n  generatePRSummary: false\n',
        );

        const result = await service.getMergedCodeReviewConfigs(
            organizationAndTeamData,
            repository,
            parameter,
            'main',
            [],
        );

        expect(result.configLevel).toBe(ConfigLevel.REPOSITORY);
        expect(result.directoryId).toBeUndefined();
    });
});
