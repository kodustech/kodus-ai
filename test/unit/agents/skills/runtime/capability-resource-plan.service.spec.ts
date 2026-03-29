import { CapabilityResourcePlanService } from '@libs/agents/skills/runtime/capability-resource-plan.service';

describe('CapabilityResourcePlanService', () => {
    it('loads seeded tools from the runtime capability seeds folder', () => {
        const service = new CapabilityResourcePlanService();

        const tools = service.getSeedTools('jira', 'task.context.read');

        expect(tools).toEqual([
            'getJiraIssue',
            'searchJiraIssuesUsingJql',
            'search',
            'fetch',
        ]);
    });

    it('loads seeded tools for non-jira providers', () => {
        const service = new CapabilityResourcePlanService();

        const linearTools = service.getSeedTools('linear', 'task.context.read');
        const notionTools = service.getSeedTools('notion', 'task.context.read');
        const clickupTools = service.getSeedTools(
            'clickup',
            'task.context.read',
        );

        expect(linearTools).toEqual([
            'LINEAR_GET_LINEAR_ISSUE',
            'LINEAR_LIST_LINEAR_ISSUES',
            'LINEAR_LIST_LINEAR_PROJECTS',
            'LINEAR_LIST_LINEAR_TEAMS',
        ]);
        expect(notionTools).toEqual([
            'NOTION_FETCH_DATA',
            'NOTION_SEARCH_NOTION_PAGE',
            'NOTION_FETCH_ROW',
            'NOTION_QUERY_DATABASE',
            'NOTION_GET_PAGE_PROPERTY_ACTION',
        ]);
        expect(clickupTools).toEqual(['CLICKUP_GET_TASK', 'CLICKUP_GET_TASKS']);
    });

    it('resolves provider aliases to canonical seed directories', () => {
        const service = new CapabilityResourcePlanService();

        const jiraTools = service.getSeedTools(
            'atlassian-jira-cloud',
            'task.context.read',
        );
        const linearTools = service.getSeedTools(
            'linear-app',
            'task.context.read',
        );
        const notionTools = service.getSeedTools(
            'notion-hq',
            'task.context.read',
        );

        expect(jiraTools).toEqual([
            'getJiraIssue',
            'searchJiraIssuesUsingJql',
            'search',
            'fetch',
        ]);
        expect(linearTools).toEqual([
            'LINEAR_GET_LINEAR_ISSUE',
            'LINEAR_LIST_LINEAR_ISSUES',
            'LINEAR_LIST_LINEAR_PROJECTS',
            'LINEAR_LIST_LINEAR_TEAMS',
        ]);
        expect(notionTools).toEqual([
            'NOTION_FETCH_DATA',
            'NOTION_SEARCH_NOTION_PAGE',
            'NOTION_FETCH_ROW',
            'NOTION_QUERY_DATABASE',
            'NOTION_GET_PAGE_PROPERTY_ACTION',
        ]);
    });

    it('stores and retrieves cached tools by tenant scope', async () => {
        const service = new CapabilityResourcePlanService();
        const scope = {
            organizationId: 'org-1',
            teamId: 'team-1',
            skillName: 'business-rules-validation',
            capability: 'task.context.read',
            provider: 'jira',
        };

        await service.saveCachedTools(scope, ['search', 'getJiraIssue']);
        const cached = await service.getCachedTools(scope);

        expect(cached).toEqual(['search', 'getJiraIssue']);
    });
});
