import { CentralizedConfigService } from './centralized-config.service';

/**
 * `synchronizeKodyRules` — what a rejected rule file tells its owner.
 *
 * Production 2026-09-28: one org synced 7 rule files and failed 22, every one
 * reported as "Rule file does not comply with required schema" — no field, no
 * reason. The zod result that knew which field was wrong was discarded, so the
 * owner (and we) could not tell what to change in the YAML.
 */
describe('CentralizedConfigService.synchronizeKodyRules — rejected rule files', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    } as any;
    const actor = {
        organizationId: 'org-1',
        source: 'sync' as const,
        userEmail: 'sync@kodus.io',
        userId: 'u-1',
    };

    function makeService(ruleContent: Record<string, unknown>) {
        const createOrUpdateKodyRulesUseCase = { execute: jest.fn() };
        const service = new CentralizedConfigService(
            {} as any, // parametersService
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([]),
            } as any,
            {} as any, // codeManagementService
            { execute: jest.fn() } as any, // updateOrCreateCodeReviewParameterUseCase
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any, // codeBaseConfigService
            createOrUpdateKodyRulesUseCase as any,
            {} as any,
            { findByOrganizationId: jest.fn().mockResolvedValue(null) } as any,
        );
        jest.spyOn(service, 'getCentralizedConfigRepository').mockResolvedValue(
            { id: 'repo-central', name: 'central' } as any,
        );
        jest.spyOn(service, 'fetchKodyRuleFile').mockResolvedValue(
            ruleContent as any,
        );
        return { service, createOrUpdateKodyRulesUseCase };
    }

    const ruleFile = {
        ruleFilePath: 'app-baseline/.kody-rules/review/add-tests.yml',
        repositoryId: 'repo-1',
    } as any;

    it('names the offending field when a rule fails the schema', async () => {
        const { service, createOrUpdateKodyRulesUseCase } = makeService({
            title: 'Add tests',
            rule: 'Every defensive branch needs a test',
            severity: 'urgent', // not one of low | medium | high | critical
        });

        const result = await service.synchronizeKodyRules({
            organizationAndTeamData,
            ruleFiles: [ruleFile],
            actor,
        });

        expect(createOrUpdateKodyRulesUseCase.execute).not.toHaveBeenCalled();
        expect(result.failureDetails).toHaveLength(1);
        expect(result.failureDetails![0].file).toBe(ruleFile.ruleFilePath);
        expect(result.failureDetails![0].error).toContain('severity');
    });

    it('names every offending field, nested ones by their full path', async () => {
        const { service } = makeService({
            title: 'Add tests',
            rule: 'Every defensive branch needs a test',
            severity: 'urgent',
            inheritance: { inheritable: 'yes', include: [], exclude: [] },
        });

        const result = await service.synchronizeKodyRules({
            organizationAndTeamData,
            ruleFiles: [ruleFile],
            actor,
        });

        const error = result.failureDetails![0].error;
        expect(error).toContain('inheritance.inheritable: ');
        expect(error).toContain('severity: ');
        expect(error).toContain('; ');
    });

    it('still syncs a rule that passes the schema', async () => {
        const { service, createOrUpdateKodyRulesUseCase } = makeService({
            title: 'Add tests',
            rule: 'Every defensive branch needs a test',
            severity: 'high',
        });

        const result = await service.synchronizeKodyRules({
            organizationAndTeamData,
            ruleFiles: [ruleFile],
            actor,
        });

        expect(createOrUpdateKodyRulesUseCase.execute).toHaveBeenCalledTimes(1);
        expect(result.failureDetails).toBeUndefined();
    });
});
