import { AutomationExecutionRepository } from './automationExecution.repository';

/**
 * The pull request queries of AutomationExecutionRepository, with the query
 * builder stubbed: which predicates each one adds, and what it answers when
 * the team has no pull request automation or the query fails.
 *
 * Whether those predicates select the right rows is the job of
 * automationExecution.repository.pull-requests.integration.spec.ts, which runs
 * them against a real Postgres.
 */

const ORG_TEAM = { organizationId: 'org-1', teamId: 'team-1' };

type Recorded = Array<{ sql: string; params?: Record<string, unknown> }>;

/** A query builder that records every predicate and returns canned results. */
const fakeBuilder = (results: {
    many?: unknown[];
    rawOne?: unknown;
    rawMany?: unknown[];
    fail?: Error;
}) => {
    const predicates: Recorded = [];
    const builder: any = { predicates, limitValue: undefined as unknown };
    const chain =
        (record = false) =>
        (sql?: string, params?: Record<string, unknown>) => {
            if (record && typeof sql === 'string')
                predicates.push({ sql, params });
            return builder;
        };

    for (const method of [
        'select',
        'addSelect',
        'innerJoin',
        'groupBy',
        'addGroupBy',
        'orderBy',
        'addOrderBy',
    ]) {
        builder[method] = jest.fn(chain());
    }
    for (const method of ['where', 'andWhere', 'having']) {
        builder[method] = jest.fn(chain(true));
    }
    builder.offset = jest.fn((value: number) => {
        builder.offsetValue = value;
        return builder;
    });
    builder.limit = jest.fn((value: number) => {
        builder.limitValue = value;
        return builder;
    });
    builder.clone = jest.fn(() => builder);
    const answer = (value: unknown) => async () => {
        if (results.fail) throw results.fail;
        return value;
    };
    builder.getMany = jest.fn(answer(results.many ?? []));
    builder.getRawOne = jest.fn(answer(results.rawOne));
    builder.getRawMany = jest.fn(answer(results.rawMany ?? []));

    return builder;
};

const build = (options: {
    teamAutomationIds?: string[];
    many?: unknown[];
    rawOne?: unknown;
    rawMany?: unknown[];
    fail?: Error;
}) => {
    const teamAutomations = fakeBuilder({
        rawMany: (options.teamAutomationIds ?? ['ta-1']).map((uuid) => ({
            uuid,
        })),
    });
    const executions = fakeBuilder(options);
    const typeormRepository = {
        createQueryBuilder: jest.fn(() => executions),
        manager: { createQueryBuilder: jest.fn(() => teamAutomations) },
    };
    const repository = new AutomationExecutionRepository(
        typeormRepository as any,
    );
    // The repository logs every failure it swallows or rethrows.
    (repository as any).logger = { error: jest.fn(), warn: jest.fn() };

    const predicate = (fragment: string) =>
        (executions.predicates as Recorded).find((p) =>
            p.sql.includes(fragment),
        );

    return {
        repository,
        typeormRepository,
        teamAutomations,
        executions,
        predicate,
    };
};

describe('AutomationExecutionRepository — team automations of the pull request queries', () => {
    it('resolves them under the organization and the team, and only those with PR executions', async () => {
        const { repository, teamAutomations } = build({});

        await repository.findPullRequestExecutionsByOrganizationAndTeam({
            organizationAndTeamData: ORG_TEAM,
            includeTotal: false,
        });

        const predicates = teamAutomations.predicates as Recorded;
        expect(predicates.map((p) => p.params)).toEqual([
            { teamId: 'team-1' },
            { organizationId: 'org-1' },
            undefined,
        ]);
        expect(predicates[0].sql).toBe('team.uuid = :teamId');
        expect(predicates[1].sql).toBe('organization.uuid = :organizationId');
        expect(predicates[2].sql).toContain(
            '"pr_execution"."team_automation_id" = "teamAutomation"."uuid"',
        );
        expect(predicates[2].sql).toContain(
            '"pr_execution"."pullRequestNumber" IS NOT NULL',
        );
        expect(predicates[2].sql).toContain(
            '"pr_execution"."repositoryId" IS NOT NULL',
        );
    });

    it('filters the executions by equality for a single automation', async () => {
        const { repository, predicate } = build({
            teamAutomationIds: ['ta-9'],
        });

        await repository.findPullRequestExecutionsByOrganizationAndTeam({
            organizationAndTeamData: ORG_TEAM,
            includeTotal: false,
        });

        // Equality is what lets (team_automation_id, createdAt, uuid) hand the
        // rows over already ordered.
        expect(
            predicate('"automation_execution"."team_automation_id" ='),
        ).toEqual({
            sql: '"automation_execution"."team_automation_id" = :teamAutomationId',
            params: { teamAutomationId: 'ta-9' },
        });
        expect(predicate('IN (:...teamAutomationIds)')).toBeUndefined();
    });

    it('filters by the whole set when the team has several', async () => {
        const { repository, predicate } = build({
            teamAutomationIds: ['ta-1', 'ta-2'],
        });

        await repository.findPullRequestExecutionsByOrganizationAndTeam({
            organizationAndTeamData: ORG_TEAM,
            includeTotal: false,
        });

        expect(predicate('IN (:...teamAutomationIds)')).toEqual({
            sql: '"automation_execution"."team_automation_id" IN (:...teamAutomationIds)',
            params: { teamAutomationIds: ['ta-1', 'ta-2'] },
        });
        expect(predicate('= :teamAutomationId')).toBeUndefined();
    });

    it('answers empty without querying executions when the team has none', async () => {
        const { repository, typeormRepository } = build({
            teamAutomationIds: [],
        });

        await expect(
            repository.findPullRequestExecutionsByOrganizationAndTeam({
                organizationAndTeamData: ORG_TEAM,
            }),
        ).resolves.toEqual({ data: [], total: 0, distinctPrTotal: 0 });
        await expect(
            repository.getDistinctReviewedPullRequestKeys({
                organizationAndTeamData: ORG_TEAM,
            }),
        ).resolves.toEqual([]);
        await expect(
            repository.getAwaitingReviewPullRequestKeys({
                organizationAndTeamData: ORG_TEAM,
            }),
        ).resolves.toEqual([]);
        expect(typeormRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('answers empty without any query when the organization or team is missing', async () => {
        const { repository, typeormRepository } = build({});

        await expect(
            repository.findPullRequestExecutionsByOrganizationAndTeam({
                organizationAndTeamData: { organizationId: 'org-1' },
            }),
        ).resolves.toEqual({ data: [], total: 0, distinctPrTotal: 0 });
        await expect(
            repository.findPullRequestExecutionsByOrganizationAndTeam({
                organizationAndTeamData: {
                    organizationId: undefined as unknown as string,
                    teamId: 'team-1',
                },
            }),
        ).resolves.toEqual({ data: [], total: 0, distinctPrTotal: 0 });
        expect(
            typeormRepository.manager.createQueryBuilder,
        ).not.toHaveBeenCalled();
        expect(typeormRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('scopes the two grouping queries to the same automations', async () => {
        const reviewed = build({ teamAutomationIds: ['ta-3'] });
        await reviewed.repository.getDistinctReviewedPullRequestKeys({
            organizationAndTeamData: ORG_TEAM,
            repositoryIds: ['r1'],
        });
        expect(reviewed.predicate('= :teamAutomationId')?.params).toEqual({
            teamAutomationId: 'ta-3',
        });

        const awaiting = build({ teamAutomationIds: ['ta-3', 'ta-4'] });
        await awaiting.repository.getAwaitingReviewPullRequestKeys({
            organizationAndTeamData: ORG_TEAM,
            repositoryIds: ['r1'],
        });
        expect(
            awaiting.predicate('IN (:...teamAutomationIds)')?.params,
        ).toEqual({ teamAutomationIds: ['ta-3', 'ta-4'] });
    });
});

describe('AutomationExecutionRepository.findPullRequestExecutionsByOrganizationAndTeam', () => {
    const execution = {
        uuid: 'exec-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        status: 'success',
        pullRequestNumber: 7,
        repositoryId: 'r1',
    };

    it('does not count when told not to', async () => {
        const { repository, executions } = build({ many: [execution] });

        const result =
            await repository.findPullRequestExecutionsByOrganizationAndTeam({
                organizationAndTeamData: ORG_TEAM,
                includeTotal: false,
                take: 10,
            });

        expect(executions.getRawOne).not.toHaveBeenCalled();
        expect(executions.limitValue).toBe(10);
        expect(result.data).toHaveLength(1);
        expect(result).toMatchObject({ total: 0, distinctPrTotal: 0 });
    });

    it('counts by default and returns the page with the totals', async () => {
        const { repository, executions } = build({
            many: [execution],
            rawOne: { cnt: '12', prCnt: '5' },
        });

        const result =
            await repository.findPullRequestExecutionsByOrganizationAndTeam({
                organizationAndTeamData: ORG_TEAM,
            });

        expect(executions.getRawOne).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ total: 12, distinctPrTotal: 5 });
        expect(result.data).toHaveLength(1);
    });

    it('answers only the totals in count-only mode, even if told not to count', async () => {
        const { repository, executions } = build({
            many: [execution],
            rawOne: { cnt: '12', prCnt: '5' },
        });

        const result =
            await repository.findPullRequestExecutionsByOrganizationAndTeam({
                organizationAndTeamData: ORG_TEAM,
                countOnly: true,
                includeTotal: false,
            });

        expect(result).toEqual({ data: [], total: 12, distinctPrTotal: 5 });
        expect(executions.getMany).not.toHaveBeenCalled();
    });

    it('answers empty, without reading a page, when the count is zero', async () => {
        const { repository, executions } = build({
            many: [execution],
            rawOne: { cnt: '0', prCnt: '0' },
        });

        await expect(
            repository.findPullRequestExecutionsByOrganizationAndTeam({
                organizationAndTeamData: ORG_TEAM,
            }),
        ).resolves.toEqual({ data: [], total: 0, distinctPrTotal: 0 });
        expect(executions.getMany).not.toHaveBeenCalled();
    });

    it('reads a failed list as empty, as it always did', async () => {
        const { repository } = build({ fail: new Error('connection reset') });

        await expect(
            repository.findPullRequestExecutionsByOrganizationAndTeam({
                organizationAndTeamData: ORG_TEAM,
                includeTotal: false,
            }),
        ).resolves.toEqual({ data: [], total: 0, distinctPrTotal: 0 });
    });

    it('fails a count it could not make instead of answering zero', async () => {
        const { repository } = build({ fail: new Error('statement timeout') });

        await expect(
            repository.findPullRequestExecutionsByOrganizationAndTeam({
                organizationAndTeamData: ORG_TEAM,
                countOnly: true,
            }),
        ).rejects.toThrow('statement timeout');
    });

    it('sends pull request keys as two arrays, scoped to the team automations', async () => {
        const { repository, predicate } = build({
            teamAutomationIds: ['ta-1', 'ta-2'],
        });

        await repository.findPullRequestExecutionsByOrganizationAndTeam({
            organizationAndTeamData: ORG_TEAM,
            includeTotal: false,
            prFilters: [
                { number: 7, repositoryId: 'r1' },
                { number: 9, repositoryId: 'r2' },
            ],
        });

        const keys = predicate('"pr_key"');
        expect(keys?.params).toEqual({
            prKeyRepositoryIds: ['r1', 'r2'],
            prKeyNumbers: [7, 9],
            prKeyTeamAutomationIds: ['ta-1', 'ta-2'],
        });
        expect(keys?.sql).toContain(
            '"automation_execution"."uuid" = ANY (ARRAY(',
        );
        expect(keys?.sql).toContain('CAST(:prKeyRepositoryIds AS varchar[])');
        expect(keys?.sql).toContain('CAST(:prKeyNumbers AS int[])');
    });

    it('adds no key predicate for an absent or empty key list', async () => {
        for (const prFilters of [undefined, []]) {
            const { repository, predicate } = build({});
            await repository.findPullRequestExecutionsByOrganizationAndTeam({
                organizationAndTeamData: ORG_TEAM,
                includeTotal: false,
                prFilters,
            });
            expect(predicate('"pr_key"')).toBeUndefined();
        }
    });
});

describe('AutomationExecutionRepository — grouping queries on failure', () => {
    it('answers an empty list by default', async () => {
        const reviewed = build({ fail: new Error('statement timeout') });
        await expect(
            reviewed.repository.getDistinctReviewedPullRequestKeys({
                organizationAndTeamData: ORG_TEAM,
            }),
        ).resolves.toEqual([]);

        const awaiting = build({ fail: new Error('statement timeout') });
        await expect(
            awaiting.repository.getAwaitingReviewPullRequestKeys({
                organizationAndTeamData: ORG_TEAM,
            }),
        ).resolves.toEqual([]);
    });

    it('rethrows for a caller that must tell "none" from "could not ask"', async () => {
        const reviewed = build({ fail: new Error('statement timeout') });
        await expect(
            reviewed.repository.getDistinctReviewedPullRequestKeys({
                organizationAndTeamData: ORG_TEAM,
                failOnError: true,
            }),
        ).rejects.toThrow('statement timeout');

        const awaiting = build({ fail: new Error('statement timeout') });
        await expect(
            awaiting.repository.getAwaitingReviewPullRequestKeys({
                organizationAndTeamData: ORG_TEAM,
                failOnError: true,
            }),
        ).rejects.toThrow('statement timeout');
    });

    it('maps the grouped rows', async () => {
        const reviewed = build({
            rawMany: [
                { repositoryId: 10, pullRequestNumber: '7', hasError: true },
                { repositoryId: 'r2', pullRequestNumber: 8, hasError: 'f' },
                { repositoryId: 'r3', pullRequestNumber: 9, hasError: 't' },
            ],
        });

        await expect(
            reviewed.repository.getDistinctReviewedPullRequestKeys({
                organizationAndTeamData: ORG_TEAM,
            }),
        ).resolves.toEqual([
            { repositoryId: '10', pullRequestNumber: 7, hasError: true },
            { repositoryId: 'r2', pullRequestNumber: 8, hasError: false },
            { repositoryId: 'r3', pullRequestNumber: 9, hasError: true },
        ]);
    });
});
