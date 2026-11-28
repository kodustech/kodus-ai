import { GetInheritedRulesKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/get-inherited-kody-rules.use-case';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

/**
 * Regression coverage for the `/inherited-rules` endpoint that feeds the
 * Kody Rules settings page.
 *
 *  - Only ACTIVE rules are inherited (paused/pending/deleted do not flow
 *    down to child scopes — the product rule is "rules count/inherit only
 *    when active").
 *  - `severity` is lower-cased to match the scope-local listing path
 *    (`KodyRulesService.find()`), so the same rule never reaches the page
 *    case-mismatched depending on which endpoint served it.
 */
describe('GetInheritedRulesKodyRulesUseCase', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const REPOSITORY_ID = 'repo-1';

    const buildUseCase = (rules: any[]) => {
        const kodyRulesService = {
            findByOrganizationId: jest.fn().mockResolvedValue({ rules }),
        };

        // Pass the candidate rules straight through so the test exercises
        // the use-case's own status filter and severity normalization
        // rather than the folder-matching logic (covered elsewhere).
        const kodyRulesValidationService = {
            getKodyRulesForFolder: jest
                .fn()
                .mockImplementation(
                    (_path: any, candidateRules: any[]) => candidateRules,
                ),
        };

        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    repositories: [{ id: REPOSITORY_ID, directories: [] }],
                },
            }),
        };

        // No rule carries a contextReferenceId, so enrichment collects an
        // empty id set and never calls the batch loader.
        const contextReferenceService = {
            findById: jest.fn(),
            findByIds: jest.fn().mockResolvedValue([]),
        };

        // The repository is on connection gh-a.
        const codeManagementService = {
            connectionIdFor: jest.fn().mockResolvedValue('gh-a'),
        };

        const useCase = new GetInheritedRulesKodyRulesUseCase(
            kodyRulesValidationService as any,
            parametersService as any,
            kodyRulesService as any,
            contextReferenceService as any,
            codeManagementService as any,
        );

        return { useCase, kodyRulesService, codeManagementService };
    };

    it("inherits another connection's own global rules only on that connection's repositories", async () => {
        const { useCase, codeManagementService } = buildUseCase([
            {
                uuid: 'other-connection',
                repositoryId: 'global',
                status: KodyRulesStatus.ACTIVE,
                centralizedConfig: {
                    sourceConnectionId: 'gl-b',
                    connectionScoped: true,
                },
                inheritance: {},
            },
            {
                uuid: 'own-connection',
                repositoryId: 'global',
                status: KodyRulesStatus.ACTIVE,
                centralizedConfig: {
                    sourceConnectionId: 'gh-a',
                    connectionScoped: true,
                },
                inheritance: {},
            },
            {
                uuid: 'workspace',
                repositoryId: 'global',
                status: KodyRulesStatus.ACTIVE,
                inheritance: {},
            },
        ]);

        const result = await useCase.execute(
            organizationAndTeamData,
            REPOSITORY_ID,
        );

        expect(codeManagementService.connectionIdFor).toHaveBeenCalledWith(
            organizationAndTeamData,
            { id: REPOSITORY_ID },
        );
        expect(result.globalRules.map((r) => r.uuid)).toEqual([
            'own-connection',
            'workspace',
        ]);
    });

    it('inherits only ACTIVE global rules', async () => {
        const { useCase } = buildUseCase([
            {
                uuid: 'active-global',
                repositoryId: 'global',
                status: KodyRulesStatus.ACTIVE,
                severity: 'high',
                inheritance: {},
            },
            {
                uuid: 'paused-global',
                repositoryId: 'global',
                status: KodyRulesStatus.PAUSED,
                severity: 'high',
                inheritance: {},
            },
            {
                uuid: 'deleted-global',
                repositoryId: 'global',
                status: KodyRulesStatus.DELETED,
                severity: 'high',
                inheritance: {},
            },
        ]);

        const result = await useCase.execute(
            organizationAndTeamData,
            REPOSITORY_ID,
        );

        const globalUuids = result.globalRules.map((r) => r.uuid);
        expect(globalUuids).toEqual(['active-global']);
    });

    it('lower-cases severity so it matches the scope-local listing path', async () => {
        const { useCase } = buildUseCase([
            {
                uuid: 'mixed-case',
                repositoryId: 'global',
                status: KodyRulesStatus.ACTIVE,
                severity: 'Critical',
                inheritance: {},
            },
        ]);

        const result = await useCase.execute(
            organizationAndTeamData,
            REPOSITORY_ID,
        );

        expect(result.globalRules[0].severity).toBe('critical');
    });

    it('returns empty buckets for the global scope (nothing to inherit)', async () => {
        const { useCase, kodyRulesService } = buildUseCase([]);

        const result = await useCase.execute(organizationAndTeamData, 'global');

        expect(result).toEqual({
            globalRules: [],
            repoRules: [],
            directoryRules: [],
        });
        // Short-circuits before touching the data layer.
        expect(kodyRulesService.findByOrganizationId).not.toHaveBeenCalled();
    });
});
