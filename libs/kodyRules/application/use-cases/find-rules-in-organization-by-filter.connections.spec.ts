import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const rule = (uuid: string, centralizedConfig?: Record<string, unknown>) => ({
    uuid,
    title: uuid,
    repositoryId: 'global',
    status: 'active',
    ...(centralizedConfig ? { centralizedConfig } : {}),
});

const build = (granted: string[] | null) =>
    new FindRulesInOrganizationByRuleFilterKodyRulesUseCase(
        {
            find: jest.fn().mockResolvedValue([
                {
                    rules: [
                        rule('workspace-wide'),
                        rule('github-own', {
                            path: 'a.yml',
                            status: 'synced',
                            sourceConnectionId: 'gh-a',
                            connectionScoped: true,
                        }),
                        rule('gitlab-own', {
                            path: 'b.yml',
                            status: 'synced',
                            sourceConnectionId: 'gl-b',
                            connectionScoped: true,
                        }),
                    ],
                },
            ]),
        } as any,
        { user: { uuid: 'u-1', organization: { uuid: 'org-1' } } } as any,
        { findByIds: jest.fn().mockResolvedValue([]) } as any,
        {
            getRepositoryScope: jest
                .fn()
                .mockResolvedValue(granted ? ['repo-1'] : null),
            ensure: jest.fn(),
        } as any,
        {
            restrictionFor: jest.fn().mockResolvedValue(
                granted
                    ? {
                          connectionIds: new Set(granted),
                          repositoryIds: new Set(['repo-1']),
                          allowsRepository: () => true,
                      }
                    : null,
            ),
        } as any,
    );

describe('FindRulesInOrganizationByRuleFilterKodyRulesUseCase — Git connections', () => {
    it('shows a member only the own global rules of the connections they are granted', async () => {
        const rules = await build(['gh-a']).execute('org-1', {});

        expect(rules.map((r: { uuid: string }) => r.uuid)).toEqual([
            'workspace-wide',
            'github-own',
        ]);
    });

    it('shows every global rule to a member granted every connection', async () => {
        const rules = await build(null).execute('org-1', {});

        expect(rules).toHaveLength(3);
    });
});
