import { CapabilityStrategyService } from '@libs/agents/skills/runtime/capability-strategy.service';

describe('CapabilityStrategyService', () => {
    it('promotes a preferred tool after repeated successful executions', async () => {
        const service = new CapabilityStrategyService();
        const base = {
            organizationId: 'org-1',
            teamId: 'team-1',
            skillName: 'business-rules-validation',
            capability: 'task.context.read',
            provider: 'jira',
            mode: 'deterministic' as const,
            status: 'success' as const,
            toolName: 'getJiraIssue',
            latencyMs: 12,
            occurredAt: new Date().toISOString(),
        };

        await service.recordExecution(base);
        await service.recordExecution(base);
        await service.recordExecution(base);

        const preferred = await service.getPreferredTool(
            {
                organizationId: 'org-1',
                teamId: 'team-1',
                skillName: 'business-rules-validation',
                capability: 'task.context.read',
                provider: 'jira',
            },
            ['searchJiraIssuesUsingJql', 'getJiraIssue'],
        );

        expect(preferred).toBe('getJiraIssue');
    });

    it('keeps strategy scoped per tenant', async () => {
        const service = new CapabilityStrategyService();

        const trace = {
            organizationId: 'org-1',
            teamId: 'team-1',
            skillName: 'business-rules-validation',
            capability: 'task.context.read',
            provider: 'jira',
            mode: 'deterministic' as const,
            status: 'success' as const,
            toolName: 'getJiraIssue',
            latencyMs: 10,
            occurredAt: new Date().toISOString(),
        };

        await service.recordExecution(trace);
        await service.recordExecution(trace);
        await service.recordExecution(trace);

        const preferredForAnotherTenant = await service.getPreferredTool(
            {
                organizationId: 'org-2',
                teamId: 'team-9',
                skillName: 'business-rules-validation',
                capability: 'task.context.read',
                provider: 'jira',
            },
            ['getJiraIssue'],
        );

        expect(preferredForAnotherTenant).toBeUndefined();
    });
});
