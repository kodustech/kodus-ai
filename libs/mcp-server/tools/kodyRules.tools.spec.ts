import { Test, TestingModule } from '@nestjs/testing';

import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { KodyRuleSeverity } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/delete-rule-in-organization-by-id.use-case';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    KodyRulesOrigin,
    KodyRulesScope,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { KodyRulesTools } from './kodyRules.tools';

describe('KodyRulesTools.createKodyRule', () => {
    const baseUrl = 'https://app.kodus.io';
    let tools: KodyRulesTools;
    let mockKodyRulesService: jest.Mocked<IKodyRulesService>;
    let mockCentralizedConfigPrService: jest.Mocked<CentralizedConfigPrService>;
    let mockDeleteRuleUseCase: jest.Mocked<DeleteRuleInOrganizationByIdKodyRulesUseCase>;
    let previousBaseUrl: string | undefined;

    beforeEach(async () => {
        previousBaseUrl = process.env.API_USER_INVITE_BASE_URL;
        process.env.API_USER_INVITE_BASE_URL = baseUrl;

        mockKodyRulesService = {
            createOrUpdate: jest.fn(),
        } as unknown as jest.Mocked<IKodyRulesService>;

        mockCentralizedConfigPrService = {
            createMutationPullRequestIfEnabled: jest
                .fn()
                .mockResolvedValue({ mode: 'direct' }),
            resolveDirectoryGroupFolderName: jest.fn().mockResolvedValue(null),
        } as unknown as jest.Mocked<CentralizedConfigPrService>;

        mockDeleteRuleUseCase =
            {} as unknown as jest.Mocked<DeleteRuleInOrganizationByIdKodyRulesUseCase>;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KodyRulesTools,
                {
                    provide: KODY_RULES_SERVICE_TOKEN,
                    useValue: mockKodyRulesService,
                },
                {
                    provide: CentralizedConfigPrService,
                    useValue: mockCentralizedConfigPrService,
                },
                {
                    provide: DeleteRuleInOrganizationByIdKodyRulesUseCase,
                    useValue: mockDeleteRuleUseCase,
                },
            ],
        }).compile();

        tools = module.get<KodyRulesTools>(KodyRulesTools);
    });

    afterEach(() => {
        process.env.API_USER_INVITE_BASE_URL = previousBaseUrl;
    });

    const runCreate = (overrides?: { repositoryId?: string }) =>
        tools.createKodyRule().execute(
            {
                organizationId: 'org-1',
                kodyRule: {
                    title: 'Avoid console.log',
                    rule: 'Do not commit console.log statements',
                    severity: KodyRuleSeverity.MEDIUM,
                    scope: KodyRulesScope.PULL_REQUEST,
                    repositoryId: overrides?.repositoryId,
                    teamId: 'team-1',
                },
            } as any,
            undefined,
        );

    it('returns a link to the pending standard-rules list when the rule is PENDING', async () => {
        mockKodyRulesService.createOrUpdate.mockResolvedValue({
            uuid: 'rule-123',
            title: 'Avoid console.log',
            rule: 'Do not commit console.log statements',
            status: KodyRulesStatus.PENDING,
            repositoryId: 'repo-1',
            origin: KodyRulesOrigin.GENERATED,
        } as any);

        const result = await runCreate({ repositoryId: 'repo-1' });

        const structured = (result as any).structuredContent;
        expect(structured.success).toBe(true);
        expect(structured.data).toEqual(
            expect.objectContaining({
                uuid: 'rule-123',
                status: KodyRulesStatus.PENDING,
            }),
        );
        expect(structured.link).toBe(
            'https://app.kodus.io/settings/code-review/repo-1/kody-rules?tab=review-rules',
        );
        expect(structured.message).toMatch(/awaiting approval/i);
    });

    it('uses the global scope when no repositoryId is provided', async () => {
        mockKodyRulesService.createOrUpdate.mockResolvedValue({
            uuid: 'rule-456',
            title: 'Avoid console.log',
            rule: 'Do not commit console.log statements',
            status: KodyRulesStatus.PENDING,
            repositoryId: 'global',
            origin: KodyRulesOrigin.GENERATED,
        } as any);

        const result = await runCreate();
        const structured = (result as any).structuredContent;

        expect(structured.link).toBe(
            'https://app.kodus.io/settings/code-review/global/kody-rules?tab=review-rules',
        );
    });

    it('returns the edit URL when the rule lands as ACTIVE (no approval needed)', async () => {
        mockKodyRulesService.createOrUpdate.mockResolvedValue({
            uuid: 'rule-789',
            title: 'Avoid console.log',
            rule: 'Do not commit console.log statements',
            status: KodyRulesStatus.ACTIVE,
            repositoryId: 'repo-1',
            origin: KodyRulesOrigin.GENERATED,
        } as any);

        const result = await runCreate({ repositoryId: 'repo-1' });
        const structured = (result as any).structuredContent;

        expect(structured.link).toBe(
            'https://app.kodus.io/settings/code-review/repo-1/kody-rules/rule-789?tab=review-rules&teamId=team-1',
        );
        expect(structured.message).not.toMatch(/awaiting/i);
    });

    it('returns the PR URL as both prUrl and link in centralized-PR mode', async () => {
        mockCentralizedConfigPrService.createMutationPullRequestIfEnabled.mockResolvedValueOnce(
            {
                mode: 'centralized-pr',
                prUrl: 'https://github.com/org/repo/pull/42',
                message: 'Centralized config is enabled.',
            } as any,
        );

        const result = await runCreate({ repositoryId: 'repo-1' });
        const structured = (result as any).structuredContent;

        expect(structured.prUrl).toBe(
            'https://github.com/org/repo/pull/42',
        );
        expect(structured.link).toBe(
            'https://github.com/org/repo/pull/42',
        );
        expect(mockKodyRulesService.createOrUpdate).not.toHaveBeenCalled();
    });
});

describe('KodyRulesTools.updateKodyRule', () => {
    const baseUrl = 'https://app.kodus.io';
    let tools: KodyRulesTools;
    let mockKodyRulesService: jest.Mocked<IKodyRulesService>;
    let mockCentralizedConfigPrService: jest.Mocked<CentralizedConfigPrService>;
    let mockDeleteRuleUseCase: jest.Mocked<DeleteRuleInOrganizationByIdKodyRulesUseCase>;
    let previousBaseUrl: string | undefined;

    beforeEach(async () => {
        previousBaseUrl = process.env.API_USER_INVITE_BASE_URL;
        process.env.API_USER_INVITE_BASE_URL = baseUrl;

        mockKodyRulesService = {
            findById: jest.fn(),
            updateRuleWithLogging: jest.fn(),
        } as unknown as jest.Mocked<IKodyRulesService>;

        mockCentralizedConfigPrService = {
            createMutationPullRequestIfEnabled: jest
                .fn()
                .mockResolvedValue({ mode: 'direct' }),
            resolveDirectoryGroupFolderName: jest.fn().mockResolvedValue(null),
        } as unknown as jest.Mocked<CentralizedConfigPrService>;

        mockDeleteRuleUseCase =
            {} as unknown as jest.Mocked<DeleteRuleInOrganizationByIdKodyRulesUseCase>;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KodyRulesTools,
                {
                    provide: KODY_RULES_SERVICE_TOKEN,
                    useValue: mockKodyRulesService,
                },
                {
                    provide: CentralizedConfigPrService,
                    useValue: mockCentralizedConfigPrService,
                },
                {
                    provide: DeleteRuleInOrganizationByIdKodyRulesUseCase,
                    useValue: mockDeleteRuleUseCase,
                },
            ],
        }).compile();

        tools = module.get<KodyRulesTools>(KodyRulesTools);
    });

    afterEach(() => {
        process.env.API_USER_INVITE_BASE_URL = previousBaseUrl;
    });

    const runUpdate = (overrides?: { teamId?: string }) =>
        tools.updateKodyRule().execute(
            {
                organizationId: 'org-1',
                ruleId: 'rule-789',
                kodyRule: {
                    title: 'Updated title',
                    teamId: overrides?.teamId ?? 'team-1',
                },
            } as any,
            undefined,
        );

    it('returns a link to the edit page and a message after a direct update', async () => {
        (mockKodyRulesService.findById as jest.Mock).mockResolvedValue({
            uuid: 'rule-789',
            title: 'Old title',
            rule: 'Some rule body',
            status: KodyRulesStatus.ACTIVE,
            repositoryId: 'repo-1',
        } as any);
        (mockKodyRulesService.updateRuleWithLogging as jest.Mock).mockResolvedValue({
            uuid: 'rule-789',
            title: 'Updated title',
            rule: 'Some rule body',
            status: KodyRulesStatus.ACTIVE,
            repositoryId: 'repo-1',
        } as any);

        const result = await runUpdate();
        const structured = (result as any).structuredContent;

        expect(structured.success).toBe(true);
        expect(structured.link).toBe(
            'https://app.kodus.io/settings/code-review/repo-1/kody-rules/rule-789?tab=review-rules&teamId=team-1',
        );
        expect(structured.message).toMatch(/updated/i);
    });

    it('returns the PR URL as both prUrl and link in centralized-PR mode on update', async () => {
        (mockKodyRulesService.findById as jest.Mock).mockResolvedValue({
            uuid: 'rule-789',
            title: 'Old title',
            rule: 'Some rule body',
            status: KodyRulesStatus.ACTIVE,
            repositoryId: 'repo-1',
        } as any);
        mockCentralizedConfigPrService.createMutationPullRequestIfEnabled.mockResolvedValueOnce(
            {
                mode: 'centralized-pr',
                prUrl: 'https://github.com/org/repo/pull/99',
                message: 'Centralized config is enabled.',
            } as any,
        );

        const result = await runUpdate();
        const structured = (result as any).structuredContent;

        expect(structured.prUrl).toBe('https://github.com/org/repo/pull/99');
        expect(structured.link).toBe('https://github.com/org/repo/pull/99');
        expect(
            mockKodyRulesService.updateRuleWithLogging,
        ).not.toHaveBeenCalled();
    });

    it('returns success=false when the rule does not exist', async () => {
        (mockKodyRulesService.findById as jest.Mock).mockResolvedValue(null);

        const result = await runUpdate();
        const structured = (result as any).structuredContent;

        expect(structured.success).toBe(false);
        expect(structured.message).toMatch(/not found/i);
    });
});
