/**
 * kodus-config.yml with keys that are configured only in the app
 * (customAgents, knowledge): the rest of the file still applies, and the
 * merged config names the dropped keys so the review can warn about them.
 * Fixture domain: an invented beekeeping-inventory service.
 */
import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

const FILE = `version: 1.2
automatedReviewActive: false
customAgents:
  - name: Hive audit
    instructions: Every hive record needs an inspection date.
knowledge:
  - path: docs/hives.md
`;

function service(fileContent: string | null) {
    const svc = Object.create(CodeBaseConfigService.prototype) as any;
    svc.DEFAULT_CONFIG = {
        automatedReviewActive: true,
        kodusConfigFileOverridesWebPreferences: false,
    };
    svc.codeManagementService = {
        getTypeIntegration: jest.fn(async () => 'github'),
        getRepositoryContentFile: jest.fn(async () =>
            fileContent === null ? null : { data: { content: fileContent } },
        ),
    };
    return svc as CodeBaseConfigService;
}

const merge = (svc: CodeBaseConfigService, fileWins = true) =>
    svc.getMergedCodeReviewConfigs(
        { organizationId: 'org-1', teamId: 'team-1' },
        { id: 'repo-1', name: 'hive-inventory' },
        {
            id: 'global',
            name: 'Global',
            isSelected: true,
            configs: {},
            repositories: [
                {
                    id: 'repo-1',
                    name: 'hive-inventory',
                    isSelected: true,
                    configs: {
                        kodusConfigFileOverridesWebPreferences: fileWins,
                    },
                },
            ],
        } as any,
        'main',
        [],
    );

describe('kodus-config.yml with app-only keys', () => {
    it('applies the rest of the file and names the dropped keys', async () => {
        const merged = await merge(service(FILE));

        expect(merged.automatedReviewActive).toBe(false);
        expect((merged as any).customAgents).toBeUndefined();
        expect((merged as any).knowledge).toBeUndefined();
        expect(merged.kodusConfigFileDroppedKeys).toEqual(
            expect.arrayContaining(['customAgents', 'knowledge']),
        );
    });

    it('names nothing for a file with only known settings', async () => {
        const merged = await merge(service('automatedReviewActive: false\n'));

        expect(merged.automatedReviewActive).toBe(false);
        expect(merged.kodusConfigFileDroppedKeys).toBeUndefined();
    });

    it('names nothing when the file is not read (web preferences win)', async () => {
        const merged = await merge(service(FILE), false);

        expect(merged.automatedReviewActive).toBe(true);
        expect(merged.kodusConfigFileDroppedKeys).toBeUndefined();
    });
});

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

/**
 * The server review path (getConfig) reconciles the rules' lock state with the
 * current plan before the review uses them — a fail-safe for a missed
 * plan-change webhook. It reuses the entity + `limited` it already resolved, so
 * the sync does no extra lookup, and the review applies the reconciled set.
 */
describe('CodeBaseConfigService.getConfig — plan-limit reconciliation', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const repository = { id: 'repo-1', name: 'my-repo' };

    const lockedRule = {
        uuid: 'r-locked',
        status: KodyRulesStatus.PAUSED,
        lockedByPlan: true,
        repositoryId: 'repo-1',
    };
    const unlockedRule = {
        ...lockedRule,
        status: KodyRulesStatus.ACTIVE,
        lockedByPlan: false,
    };

    const buildService = (limited: boolean) => {
        const loadedEntity = { toObject: () => ({ rules: [lockedRule] }) };

        const parametersService = {
            findOne: jest.fn().mockResolvedValue({ configValue: {} }),
            findByKey: jest.fn().mockResolvedValue({ configValue: 'en-US' }),
        };
        const kodyRulesService = {
            findByOrganizationId: jest.fn().mockResolvedValue(loadedEntity),
            // Paid → reconcile returns the fresh doc with the rule reactivated.
            syncRulesWithPlanLimit: jest.fn().mockResolvedValue({
                toObject: () => ({ rules: [unlockedRule] }),
            }),
        };
        const filterKodyRules = jest
            .fn()
            .mockReturnValue({ standardRules: [unlockedRule], memoryRules: [] });
        const kodyRulesValidationService = { filterKodyRules };
        const permissionValidationService = {
            shouldLimitResources: jest.fn().mockResolvedValue(limited),
        };
        const codeManagementService = {
            verifyConnection: jest
                .fn()
                .mockResolvedValue({ hasConnection: true, isSetupComplete: true }),
        };

        const service = new CodeBaseConfigService(
            {} as any, // integrationService
            {} as any, // integrationConfigService
            {} as any, // organizationParametersService
            parametersService as any,
            kodyRulesService as any,
            {} as any, // globalParametersService
            codeManagementService as any,
            kodyRulesValidationService as any,
            permissionValidationService as any,
            {} as any, // cacheService
        );

        jest.spyOn(service as any, 'getDefaultBranch').mockResolvedValue('main');
        jest
            .spyOn(service as any, 'getReviewModeConfigParameter')
            .mockResolvedValue({});
        jest
            .spyOn(service as any, 'getMergedCodeReviewConfigs')
            .mockResolvedValue({
                directoryId: undefined,
                ignorePaths: [],
                v2PromptOverrides: {},
            });
        jest
            .spyOn(service as any, 'sanitizeV2PromptOverrides')
            .mockReturnValue({});

        return { service, kodyRulesService, filterKodyRules, loadedEntity };
    };

    it('reconciles before the review and applies the synced rules (paid plan)', async () => {
        const { service, kodyRulesService, filterKodyRules, loadedEntity } =
            buildService(false);

        await service.getConfig(organizationAndTeamData, repository);

        // Called with the already-loaded entity + the resolved plan gate.
        expect(kodyRulesService.syncRulesWithPlanLimit).toHaveBeenCalledWith(
            organizationAndTeamData,
            { entity: loadedEntity, limited: false },
        );
        // filterKodyRules must receive the reconciled (ACTIVE) rule.
        expect(filterKodyRules.mock.calls[0][0]).toEqual([unlockedRule]);
    });

    it('passes the free-plan gate through so the sync can enforce the cap', async () => {
        const { service, kodyRulesService } = buildService(true);
        // On free the reconcile no-ops here (returns null); the parked rule
        // flows through unchanged.
        kodyRulesService.syncRulesWithPlanLimit.mockResolvedValue(null);

        await service.getConfig(organizationAndTeamData, repository);

        expect(kodyRulesService.syncRulesWithPlanLimit).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({ limited: true }),
        );
    });
});
