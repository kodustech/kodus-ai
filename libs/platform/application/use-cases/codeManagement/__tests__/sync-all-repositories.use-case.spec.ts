import { encrypt } from '@libs/common/utils/crypto';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';

import { SyncAllRepositoriesUseCase } from '../sync-all-repositories.use-case';

type Store = Map<string, unknown>;

const key = (teamId: string, configKey: string) => `${teamId}:${configKey}`;

const repo = (id: string, flags: Record<string, boolean> = {}) => ({
    id,
    name: `r${id}`,
    full_name: `acme/r${id}`,
    http_url: `https://git.example/acme/r${id}.git`,
    organizationName: 'acme',
    ...flags,
});

const TEAMS = {
    a: { organizationId: 'org-1', teamId: 'team-a' },
    b: { organizationId: 'org-1', teamId: 'team-b' },
};

const setup = (
    opts: {
        listing?: any[] | Error;
        teams?: Array<{
            orgTeam: { organizationId: string; teamId: string };
            mode?: 'manual' | 'all';
            includeForksAndMirrors?: boolean;
            token?: string;
            selected?: any[];
            state?: Record<string, unknown>;
            failures?: Record<string, unknown>;
        }>;
        webhookResult?: (repos: any[]) => any;
        inFlightAst?: number;
        lockAcquired?: boolean;
    } = {},
) => {
    const store: Store = new Map();
    const teams = opts.teams ?? [{ orgTeam: TEAMS.a, mode: 'all' }];

    for (const team of teams) {
        const t = team.orgTeam.teamId;
        store.set(key(t, IntegrationConfigKey.REPOSITORY_SELECTION), {
            mode: team.mode ?? 'all',
            includeForksAndMirrors: team.includeForksAndMirrors,
        });
        store.set(key(t, IntegrationConfigKey.REPOSITORIES), team.selected ?? []);
        if (team.state) {
            store.set(key(t, IntegrationConfigKey.REPOSITORY_SYNC_STATE), team.state);
        }
        if (team.failures) {
            store.set(key(t, IntegrationConfigKey.WEBHOOK_CREATION_FAILURES), {
                failures: team.failures,
            });
        }
    }

    const integrationConfigService = {
        find: jest.fn(async ({ configKey }) =>
            teams.map((team) => ({
                uuid: `cfg-${team.orgTeam.teamId}`,
                configKey,
                configValue: store.get(key(team.orgTeam.teamId, configKey)),
                // The relations `find` loads: the organization comes with the
                // integration, the team comes bare.
                team: {
                    uuid: team.orgTeam.teamId,
                    status: STATUS.ACTIVE,
                },
                integration: {
                    uuid: `int-${team.orgTeam.teamId}`,
                    platform: 'GITLAB',
                    status: true,
                    organization: { uuid: team.orgTeam.organizationId },
                },
            })),
        ),
        findIntegrationConfigFormatted: jest.fn(
            async (configKey: string, orgTeam: { teamId: string }) =>
                store.get(key(orgTeam.teamId, configKey)) ?? null,
        ),
        createOrUpdateConfig: jest.fn(
            async (configKey: string, value: unknown, _int: string, orgTeam) => {
                store.set(key(orgTeam.teamId, configKey), value);
                return { configValue: value };
            },
        ),
    };

    const integrationService = {
        getPlatformAuthDetails: jest.fn(async (orgTeam: { teamId: string }) => {
            const team = teams.find((t) => t.orgTeam.teamId === orgTeam.teamId);
            return {
                host: 'gitlab.example',
                accessToken: encrypt(team?.token ?? 'shared-token'),
            };
        }),
    };

    const codeManagementService = {
        getRepositories: jest.fn(async () => {
            if (opts.listing instanceof Error) throw opts.listing;
            return opts.listing ?? [];
        }),
        createOrUpdateIntegrationConfig: jest.fn(
            async ({ configValue, organizationAndTeamData }) => {
                const k = key(
                    organizationAndTeamData.teamId,
                    IntegrationConfigKey.REPOSITORIES,
                );
                const current = (store.get(k) as any[]) ?? [];
                store.set(k, [...current, ...configValue]);
            },
        ),
        ensureRepositoryWebhooks: jest.fn(async ({ repositories }) =>
            opts.webhookResult
                ? opts.webhookResult(repositories)
                : {
                      configured: repositories.map((r: any) => String(r.id)),
                      failed: {},
                      notAttempted: [],
                  },
        ),
    };

    const updateCodeReviewParameterRepositoriesUseCase = {
        execute: jest.fn().mockResolvedValue(true),
    };

    const repositoryConnectionService = {
        registerRepositoryRecords: jest.fn(async ({ repositories }) =>
            repositories.map((repository: any) => ({
                repository,
                record: { uuid: `rec-${repository.id}` },
            })),
        ),
        findRepositoryRecord: jest.fn(async (_platform, externalId) => ({
            uuid: `rec-${externalId}`,
        })),
        enqueueAstBuild: jest.fn().mockResolvedValue(true),
        countInFlightAstBuilds: jest.fn().mockResolvedValue(opts.inFlightAst ?? 0),
        startHistoricalBackfill: jest.fn().mockReturnValue(true),
    };

    const release = jest.fn().mockResolvedValue(undefined);
    const distributedLockService = {
        acquire: jest
            .fn()
            .mockResolvedValue(opts.lockAcquired === false ? null : { release }),
    };

    const useCase = new SyncAllRepositoriesUseCase(
        integrationConfigService as any,
        integrationService as any,
        codeManagementService as any,
        updateCodeReviewParameterRepositoriesUseCase as any,
        repositoryConnectionService as any,
        distributedLockService as any,
    );

    const state = (teamId: string) =>
        store.get(key(teamId, IntegrationConfigKey.REPOSITORY_SYNC_STATE)) as any;
    const selected = (teamId: string) =>
        (store.get(key(teamId, IntegrationConfigKey.REPOSITORIES)) as any[]).map(
            (r) => r.id,
        );

    return {
        useCase,
        store,
        state,
        selected,
        codeManagementService,
        updateCodeReviewParameterRepositoriesUseCase,
        repositoryConnectionService,
        distributedLockService,
        release,
    };
};

describe('SyncAllRepositoriesUseCase', () => {
    it('adds every repository the credential sees and is not yet selected, skipping archived ones and forks', async () => {
        const t = setup({
            listing: [
                repo('1'),
                repo('2'),
                repo('3', { archived: true }),
                repo('4', { fork: true }),
                repo('5', { mirror: true }),
            ],
            teams: [{ orgTeam: TEAMS.a, mode: 'all', selected: [repo('1')] }],
        });

        await t.useCase.syncTeam(TEAMS.a, 'enable');

        expect(t.selected('team-a')).toEqual(['1', '2']);
        expect(
            t.codeManagementService.createOrUpdateIntegrationConfig,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                configKey: IntegrationConfigKey.REPOSITORIES,
                type: 'append',
                deferWebhooks: true,
                configValue: [expect.objectContaining({ id: '2', selected: true })],
            }),
            'GITLAB',
        );
        expect(t.state('team-a')).toMatchObject({
            status: 'done',
            visible: 5,
            added: 1,
            skipped: { archived: 1, forksAndMirrors: 2 },
        });
    });

    it('includes forks and mirrors when the team asked for them', async () => {
        const t = setup({
            listing: [repo('1', { fork: true }), repo('2', { mirror: true })],
            teams: [
                { orgTeam: TEAMS.a, mode: 'all', includeForksAndMirrors: true },
            ],
        });

        await t.useCase.syncTeam(TEAMS.a, 'enable');

        expect(t.selected('team-a')).toEqual(['1', '2']);
    });

    it('never removes a repository the credential no longer sees', async () => {
        const t = setup({
            listing: [repo('2')],
            teams: [{ orgTeam: TEAMS.a, mode: 'all', selected: [repo('1')] }],
        });

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        expect(t.selected('team-a')).toEqual(['1', '2']);
        for (const [call] of t.codeManagementService
            .createOrUpdateIntegrationConfig.mock.calls) {
            expect(call.type).toBe('append');
        }
    });

    it('writes nothing to the selection when discovery fails, and records the failure', async () => {
        const t = setup({
            listing: new Error('provider down'),
            teams: [{ orgTeam: TEAMS.a, mode: 'all', selected: [repo('1')] }],
        });

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        expect(
            t.codeManagementService.createOrUpdateIntegrationConfig,
        ).not.toHaveBeenCalled();
        expect(t.state('team-a')).toMatchObject({
            status: 'failed',
            error: expect.stringContaining('provider down'),
        });
    });

    it('does nothing for a team on manual selection', async () => {
        const t = setup({
            listing: [repo('1')],
            teams: [{ orgTeam: TEAMS.a, mode: 'manual' }],
        });

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        expect(t.codeManagementService.getRepositories).not.toHaveBeenCalled();
    });

    it('sets up webhooks for new repositories and retries the pending ones, recording the outcome', async () => {
        const t = setup({
            listing: [repo('1'), repo('2')],
            teams: [
                {
                    orgTeam: TEAMS.a,
                    mode: 'all',
                    selected: [repo('1')],
                    failures: { '1': { reason: 'HTTP 403', at: '2026-01-01' } },
                },
            ],
        });

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        const ids = t.codeManagementService.ensureRepositoryWebhooks.mock.calls
            .flatMap(([p]) => p.repositories.map((r: any) => r.id))
            .sort();
        expect(ids).toEqual(['1', '2']);
        expect(
            (t.store.get(
                key('team-a', IntegrationConfigKey.WEBHOOK_CREATION_FAILURES),
            ) as any).failures,
        ).toEqual({});
    });

    it('stops a rate-limited credential, keeps the rest as pending and leaves the other teams on it for the next run', async () => {
        const t = setup({
            listing: [repo('1'), repo('2'), repo('3')],
            teams: [
                { orgTeam: TEAMS.a, mode: 'all' },
                { orgTeam: TEAMS.b, mode: 'all' },
            ],
            webhookResult: (repos) => ({
                configured: [String(repos[0].id)],
                failed: {
                    [String(repos[1].id)]: {
                        reason: 'HTTP 429',
                        kind: 'rate_limited',
                        retryAfterMs: 60_000,
                    },
                },
                notAttempted: repos.slice(2).map((r: any) => String(r.id)),
                rateLimited: { retryAfterMs: 60_000 },
            }),
        });

        await t.useCase.runScheduledSync();

        expect(t.state('team-a')).toMatchObject({ status: 'rate_limited' });
        expect(
            Object.keys(
                (t.store.get(
                    key('team-a', IntegrationConfigKey.WEBHOOK_CREATION_FAILURES),
                ) as any).failures,
            ).sort(),
        ).toEqual(['2', '3']);
        expect(t.codeManagementService.ensureRepositoryWebhooks).toHaveBeenCalledTimes(1);
        // The 429'd repository was attempted; the one after it was not.
        expect(t.state('team-a').done).toBe(2);
        expect(t.state('team-b')).toMatchObject({ status: 'rate_limited' });
    });

    it('stops at the first deferred webhook batch and leaves the rest pending, without waiting again per batch', async () => {
        const listing = Array.from({ length: 60 }, (_, i) => repo(String(i)));
        const t = setup({
            listing,
            webhookResult: (repos) => ({
                configured: [],
                failed: {},
                notAttempted: repos.map((r: any) => String(r.id)),
                deferred: { reason: 'Another setup was running' },
            }),
        });

        await t.useCase.syncTeam(TEAMS.a, 'enable');

        expect(t.codeManagementService.ensureRepositoryWebhooks).toHaveBeenCalledTimes(1);
        const failures = (t.store.get(
            key('team-a', IntegrationConfigKey.WEBHOOK_CREATION_FAILURES),
        ) as any).failures;
        expect(Object.keys(failures)).toHaveLength(60);
        expect(failures['59'].kind).toBe('deferred');
        expect(t.state('team-a')).toMatchObject({
            status: 'deferred',
            done: 0,
            total: 60,
            error: 'Another setup was running',
        });
        expect(t.state('team-a').lastSuccessAt).toBeUndefined();
    });

    it('keeps the last successful sync time when a later run is deferred', async () => {
        const t = setup({
            listing: [repo('1')],
            teams: [
                {
                    orgTeam: TEAMS.a,
                    mode: 'all',
                    state: {
                        status: 'done',
                        startedAt: '2026-01-01',
                        lastSuccessAt: '2026-01-01T00:10:00.000Z',
                    },
                },
            ],
            webhookResult: (repos) => ({
                configured: [],
                failed: {},
                notAttempted: repos.map((r: any) => String(r.id)),
                deferred: { reason: 'Another setup was running' },
            }),
        });

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        expect(t.state('team-a')).toMatchObject({
            status: 'deferred',
            lastSuccessAt: '2026-01-01T00:10:00.000Z',
        });
    });

    it('lists once for teams that share a credential', async () => {
        const t = setup({
            listing: [repo('1')],
            teams: [
                { orgTeam: TEAMS.a, mode: 'all', token: 'same' },
                { orgTeam: TEAMS.b, mode: 'all', token: 'same' },
            ],
        });

        await t.useCase.runScheduledSync();

        expect(t.codeManagementService.getRepositories).toHaveBeenCalledTimes(1);
        expect(t.selected('team-a')).toEqual(['1']);
        expect(t.selected('team-b')).toEqual(['1']);
    });

    it('lists separately for teams with different credentials', async () => {
        const t = setup({
            listing: [repo('1')],
            teams: [
                { orgTeam: TEAMS.a, mode: 'all', token: 'one' },
                { orgTeam: TEAMS.b, mode: 'all', token: 'two' },
            ],
        });

        await t.useCase.runScheduledSync();

        expect(t.codeManagementService.getRepositories).toHaveBeenCalledTimes(2);
    });

    it('skips the run when another process holds the credential lock', async () => {
        const t = setup({ listing: [repo('1')], lockAcquired: false });

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        expect(t.codeManagementService.getRepositories).not.toHaveBeenCalled();
    });

    it('releases the lock after the run', async () => {
        const t = setup({ listing: [repo('1')] });

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        expect(t.release).toHaveBeenCalledTimes(1);
    });

    it('adds the code review config entries through the sync actor', async () => {
        const t = setup({ listing: [repo('1')] });

        await t.useCase.syncTeam(TEAMS.a, 'enable');

        expect(
            t.updateCodeReviewParameterRepositoriesUseCase.execute,
        ).toHaveBeenCalledWith({
            organizationAndTeamData: TEAMS.a,
            actor: { source: 'sync', organizationId: 'org-1' },
        });
    });

    it('enqueues AST builds only up to the per-team cap and keeps the rest pending', async () => {
        const t = setup({
            listing: ['1', '2', '3', '4', '5', '6'].map((id) => repo(id)),
            inFlightAst: 3,
        });

        await t.useCase.syncTeam(TEAMS.a, 'enable');

        expect(
            t.repositoryConnectionService.enqueueAstBuild,
        ).toHaveBeenCalledTimes(2);
        expect(t.state('team-a').pendingAstRepositoryIds).toEqual([
            '3',
            '4',
            '5',
            '6',
        ]);
    });

    it('drains pending AST builds on later runs', async () => {
        const t = setup({
            listing: [repo('1'), repo('2')],
            teams: [
                {
                    orgTeam: TEAMS.a,
                    mode: 'all',
                    selected: [repo('1'), repo('2')],
                    state: {
                        status: 'done',
                        startedAt: '2026-01-01',
                        pendingAstRepositoryIds: ['1', '2'],
                    },
                },
            ],
        });

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        expect(
            t.repositoryConnectionService.enqueueAstBuild,
        ).toHaveBeenCalledTimes(2);
        expect(t.state('team-a').pendingAstRepositoryIds).toEqual([]);
    });

    it('keeps a pending AST build whose record is missing or whose enqueue fails, for the next run', async () => {
        const t = setup({
            listing: [repo('1'), repo('2'), repo('3')],
            teams: [
                {
                    orgTeam: TEAMS.a,
                    mode: 'all',
                    selected: [repo('1'), repo('2'), repo('3')],
                    state: {
                        status: 'done',
                        startedAt: '2026-01-01',
                        pendingAstRepositoryIds: ['1', '2', '3'],
                    },
                },
            ],
        });
        t.repositoryConnectionService.findRepositoryRecord.mockImplementation(
            async (_platform: string, id: string) =>
                id === '1' ? null : { uuid: `rec-${id}` },
        );
        t.repositoryConnectionService.enqueueAstBuild.mockImplementation(
            async ({ record }: { record: { uuid: string } }) => {
                if (record.uuid === 'rec-2') throw new Error('queue down');
                return true;
            },
        );

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        expect(t.state('team-a').pendingAstRepositoryIds).toEqual(['1', '2']);
    });

    it('drops a pending AST build for a repository no longer selected', async () => {
        const t = setup({
            listing: [repo('1')],
            teams: [
                {
                    orgTeam: TEAMS.a,
                    mode: 'all',
                    selected: [repo('1')],
                    state: {
                        status: 'done',
                        startedAt: '2026-01-01',
                        pendingAstRepositoryIds: ['gone', '1'],
                        pendingAstAttempts: { gone: 2 },
                    },
                },
            ],
        });

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        expect(
            t.repositoryConnectionService.findRepositoryRecord,
        ).not.toHaveBeenCalledWith(expect.anything(), 'gone');
        expect(t.state('team-a').pendingAstRepositoryIds).toEqual([]);
        expect(t.state('team-a').pendingAstAttempts ?? {}).toEqual({});
    });

    it('gives up on a pending AST build after a bounded number of failed attempts', async () => {
        const t = setup({
            listing: [repo('1')],
            teams: [
                {
                    orgTeam: TEAMS.a,
                    mode: 'all',
                    selected: [repo('1')],
                    state: {
                        status: 'done',
                        startedAt: '2026-01-01',
                        pendingAstRepositoryIds: ['1'],
                    },
                },
            ],
        });
        t.repositoryConnectionService.findRepositoryRecord.mockResolvedValue(null);
        const runs = SyncAllRepositoriesUseCase.AST_MAX_ATTEMPTS;

        for (let run = 1; run < runs; run += 1) {
            await t.useCase.syncTeam(TEAMS.a, 'cron');
            expect(t.state('team-a').pendingAstRepositoryIds).toEqual(['1']);
            expect(t.state('team-a').pendingAstAttempts).toEqual({ '1': run });
        }

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        expect(t.state('team-a').pendingAstRepositoryIds).toEqual([]);
        expect(t.state('team-a').pendingAstAttempts ?? {}).toEqual({});
    });

    it('forgets the attempt count once the AST build is enqueued', async () => {
        const t = setup({
            listing: [repo('1')],
            teams: [
                {
                    orgTeam: TEAMS.a,
                    mode: 'all',
                    selected: [repo('1')],
                    state: {
                        status: 'done',
                        startedAt: '2026-01-01',
                        pendingAstRepositoryIds: ['1'],
                        pendingAstAttempts: { '1': 2 },
                    },
                },
            ],
        });

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        expect(t.state('team-a').pendingAstRepositoryIds).toEqual([]);
        expect(t.state('team-a').pendingAstAttempts ?? {}).toEqual({});
    });

    it('holds the credential lock for the whole run instead of letting a timer release it', async () => {
        const t = setup({ listing: [repo('1')] });

        await t.useCase.syncTeam(TEAMS.a, 'cron');

        const [, options] = t.distributedLockService.acquire.mock.calls[0];
        expect(options?.ttl).toBeUndefined();
    });

    it('starts the history backfill for a bounded batch of new repositories per run', async () => {
        const listing = Array.from({ length: 30 }, (_, i) => repo(String(i)));
        const t = setup({ listing });

        await t.useCase.syncTeam(TEAMS.a, 'enable');

        const [, batch] =
            t.repositoryConnectionService.startHistoricalBackfill.mock.calls[0];
        expect(batch).toHaveLength(SyncAllRepositoriesUseCase.BACKFILL_PER_RUN);
        expect(t.state('team-a').pendingBackfillRepositoryIds).toHaveLength(
            30 - SyncAllRepositoriesUseCase.BACKFILL_PER_RUN,
        );
    });

    it('previews how many repositories enabling would add', async () => {
        const t = setup({
            listing: [repo('1'), repo('2'), repo('3', { archived: true })],
            teams: [{ orgTeam: TEAMS.a, mode: 'manual', selected: [repo('1')] }],
        });

        await expect(
            t.useCase.preview(TEAMS.a, { includeForksAndMirrors: false }),
        ).resolves.toEqual({
            visible: 3,
            eligible: 2,
            alreadySelected: 1,
            toAdd: 1,
            skipped: { archived: 1, forksAndMirrors: 0 },
        });
        expect(
            t.codeManagementService.createOrUpdateIntegrationConfig,
        ).not.toHaveBeenCalled();
    });

    describe('syncInstallation', () => {
        const githubSetup = () => {
            const t = setup({
                listing: [repo('1')],
                teams: [
                    { orgTeam: TEAMS.a, mode: 'all' },
                    { orgTeam: TEAMS.b, mode: 'all' },
                ],
            });
            (t as any).useCase['integrationConfigService'].find.mockImplementation(
                async ({ configKey }: { configKey: string }) =>
                    [TEAMS.a, TEAMS.b].map((orgTeam) => ({
                        configKey,
                        configValue: t.store.get(key(orgTeam.teamId, configKey)),
                        team: { uuid: orgTeam.teamId, status: STATUS.ACTIVE },
                        integration: {
                            uuid: `int-${orgTeam.teamId}`,
                            platform: 'GITHUB',
                            status: true,
                            organization: { uuid: orgTeam.organizationId },
                        },
                    })),
            );
            (t as any).useCase[
                'integrationService'
            ].getPlatformAuthDetails.mockImplementation(
                async (orgTeam: { teamId: string }) => ({
                    installationId: orgTeam.teamId === 'team-a' ? 42 : 99,
                }),
            );
            return t;
        };

        it('syncs only the teams on that GitHub App installation', async () => {
            const t = githubSetup();

            await t.useCase.syncInstallation('42');

            expect(t.selected('team-a')).toEqual(['1']);
            expect(t.selected('team-b')).toEqual([]);
        });

        it('does nothing for an installation no team in "all" mode uses', async () => {
            const t = githubSetup();

            await t.useCase.syncInstallation('7');

            expect(t.codeManagementService.getRepositories).not.toHaveBeenCalled();
        });
    });
});
