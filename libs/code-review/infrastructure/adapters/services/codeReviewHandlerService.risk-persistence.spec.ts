import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { CodeReviewHandlerService } from './codeReviewHandlerService.service';

it.each(['success', 'partial', 'error'] as const)(
    'returns shared risk and approval evidence to the automation on %s',
    async (outcome) => {
        const shared = {
            riskAssessment: {
                status: 'assessed',
                riskIdentified: false,
                reason: 'Restricted static change.',
                snapshot: {
                    organizationId: 'org',
                    repositoryId: 'repo',
                    prNumber: 1,
                    baseSha: 'base',
                    headSha: 'head',
                    assessmentKey: 'assessment',
                    configurationKey: 'config',
                },
            },
            approvalPolicyEligibility: {
                clean: { judgment: 'eligible', key: 'exact-snapshot' },
            },
            approvalReviewSummary: { reviewClean: true, headSha: 'head' },
            customAgentRiskSkips: [
                { id: 'risk-watch', reason: 'No risk confirmed.' },
            ],
        };
        const execute = jest.fn(async (context) => ({
            ...context,
            ...shared,
            lastAnalyzedCommit: outcome === 'error' ? null : { sha: 'head' },
            errors:
                outcome === 'success'
                    ? []
                    : [
                          {
                              stage: 'AgentReviewStage',
                              error: new Error('Review interrupted'),
                              severity:
                                  outcome === 'partial'
                                      ? 'partial'
                                      : 'critical',
                          },
                      ],
        }));
        const handler = new CodeReviewHandlerService(
            { getPipeline: () => ({ execute }) } as any,
            {
                addReactionToPR: jest.fn(),
                removeReactionsFromPR: jest.fn(),
            } as any,
            {
                findByKey: jest
                    .fn()
                    .mockResolvedValue({ configValue: 'already-captured' }),
            } as any,
            {} as any,
            {} as any,
            {} as any,
            { consumeTrialReviewCreditOnSuccess: jest.fn() } as any,
        );
        const result = await handler.handlePullRequest(
            { organizationId: 'org', teamId: 'team' },
            { id: 'repo', name: 'repo' },
            'main',
            { number: 1 },
            PlatformType.GITHUB,
            'automation',
            'automation',
            'opened',
            'execution',
        );
        expect(result).toMatchObject(shared);
        expect(result.statusInfo.status).toBe(
            outcome === 'success'
                ? AutomationStatus.SUCCESS
                : outcome === 'partial'
                  ? AutomationStatus.PARTIAL_ERROR
                  : AutomationStatus.ERROR,
        );
    },
);
