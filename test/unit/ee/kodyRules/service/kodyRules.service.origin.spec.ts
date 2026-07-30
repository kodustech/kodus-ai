import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';
import {
    KodyRulesScope,
    KodyRulesOrigin,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * `createOrUpdate` keeps an explicit `origin` and otherwise defaults to
 * `MANUAL` — it does not infer from `sourcePath` (that's `resolveKodyRuleOrigin`).
 */
describe('KodyRulesService.createOrUpdate stamps origin', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const buildService = () => {
        const addRule = jest
            .fn()
            .mockImplementation((_docUuid, rule) =>
                Promise.resolve({ rules: [rule] }),
            );
        const repositoryMock = {
            // Existing doc with no rules → create lands on the addRule branch.
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ uuid: 'kr-1', rules: [] }),
            addRule,
        };

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            { validateRulesLimit: jest.fn().mockResolvedValue(true) } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

        return { service, addRule };
    };

    const userInfo = { userId: 'u1', userEmail: 'u1@kodus.io' } as any;

    const baseRule = {
        title: 'New rule',
        rule: 'do something',
        path: '**/*',
        severity: 'medium',
        scope: KodyRulesScope.FILE,
        type: KodyRulesType.STANDARD,
    };

    const persistedSource = async (rulePayload: Record<string, unknown>) => {
        const { service, addRule } = buildService();
        await service.createOrUpdate(
            organizationAndTeamData,
            rulePayload as any,
            userInfo,
        );
        return addRule.mock.calls[0][1].origin;
    };

    it('keeps an explicit origin verbatim', async () => {
        expect(
            await persistedSource({
                ...baseRule,
                origin: KodyRulesOrigin.MCP_AGENT,
            }),
        ).toBe(KodyRulesOrigin.MCP_AGENT);
    });

    it('defaults to MANUAL when no origin is set (runtime does not infer from sourcePath — that is the migration helper job)', async () => {
        expect(
            await persistedSource({
                ...baseRule,
                sourcePath: '.cursorrules',
            }),
        ).toBe(KodyRulesOrigin.MANUAL);
    });

    it('defaults to MANUAL for a plain rule', async () => {
        expect(
            await persistedSource({
                ...baseRule,
                status: KodyRulesStatus.ACTIVE,
            }),
        ).toBe(KodyRulesOrigin.MANUAL);
    });
});
