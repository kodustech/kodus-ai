jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

import { ParametersKey } from '@libs/core/domain/enums';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

import { AutoPauseKodyRulesUseCase } from './auto-pause-kody-rules.use-case';

const NOW = new Date('2026-10-20T06:00:00.000Z');
const THIRTY_DAYS_AGO = '2026-09-20T06:00:00.000Z';

const ORG = 'org-1';

const rule = (uuid: string, over: Record<string, unknown> = {}) => ({
    uuid,
    title: `Rule ${uuid}`,
    rule: 'text',
    repositoryId: 'repo-1',
    status: KodyRulesStatus.ACTIVE,
    ...over,
});

const usageRow = (ruleId: string, over: Record<string, unknown> = {}) => ({
    ruleId,
    triggers: 10,
    implemented: 6,
    rate: 0.6,
    thumbsUp: 0,
    thumbsDown: 0,
    lastTriggeredAt: null,
    ...over,
});

const IGNORED = { triggers: 14, implemented: 2, rate: 0.14 };
const NOISY = { triggers: 20, implemented: 10, rate: 0.5, thumbsDown: 5 };

describe('AutoPauseKodyRulesUseCase', () => {
    let reviewAnalytics: {
        getKodyRulesUsage: jest.Mock;
        getRepositoryNames: jest.Mock;
    };
    let kodyRulesService: {
        findByOrganizationId: jest.Mock;
        findOrganizationIdsWithRules: jest.Mock;
        createOrUpdate: jest.Mock;
    };
    let teamService: { find: jest.Mock };
    let parametersService: { findByKey: jest.Mock };
    let licenseService: { validateOrganizationLicense: jest.Mock };
    let health: { ping: jest.Mock; runsSummary: jest.Mock };
    let notificationService: { emit: jest.Mock };
    let useCase: AutoPauseKodyRulesUseCase;

    let codeReviewConfig: Record<string, unknown>;
    let centralizedConfig: Record<string, unknown> | undefined;

    const givenRules = (rules: unknown[]) =>
        kodyRulesService.findByOrganizationId.mockResolvedValue({
            uuid: 'doc-1',
            rules,
        });

    beforeEach(() => {
        codeReviewConfig = { configs: { kodyRulesAutoPauseEnabled: true } };
        centralizedConfig = undefined;

        reviewAnalytics = {
            getKodyRulesUsage: jest.fn().mockResolvedValue([]),
            getRepositoryNames: jest
                .fn()
                .mockResolvedValue(new Map([['repo-1', 'acme/api']])),
        };
        kodyRulesService = {
            findByOrganizationId: jest.fn(),
            findOrganizationIdsWithRules: jest.fn().mockResolvedValue([ORG]),
            createOrUpdate: jest.fn().mockImplementation(async (_org, r) => r),
        };
        teamService = {
            find: jest.fn().mockResolvedValue([{ uuid: 'team-1' }]),
        };
        parametersService = {
            findByKey: jest.fn().mockImplementation(async (key) => {
                if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                    return { configValue: codeReviewConfig };
                }
                if (key === ParametersKey.CENTRALIZED_CONFIG) {
                    return centralizedConfig
                        ? { configValue: centralizedConfig }
                        : null;
                }
                return null;
            }),
        };
        licenseService = {
            validateOrganizationLicense: jest.fn().mockResolvedValue({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'teams_byok',
            }),
        };
        health = {
            ping: jest.fn().mockResolvedValue({ status: 'ok' }),
            runsSummary: jest.fn().mockResolvedValue({ lagHours: 1 }),
        };
        notificationService = {
            emit: jest.fn().mockResolvedValue(undefined),
        };

        useCase = new AutoPauseKodyRulesUseCase(
            reviewAnalytics as any,
            kodyRulesService as any,
            teamService as any,
            parametersService as any,
            licenseService as any,
            health as any,
            notificationService as any,
        );
    });

    describe('run gate', () => {
        it('does nothing when the analytics warehouse is unreachable', async () => {
            health.ping.mockResolvedValue({ status: 'degraded' });

            const result = await useCase.execute(NOW);

            expect(result.skipped).toBe('warehouse_unavailable');
            expect(
                kodyRulesService.findOrganizationIdsWithRules,
            ).not.toHaveBeenCalled();
        });

        it.each([
            ['never ingested', null],
            ['behind by more than a day', 30],
        ])('does nothing when ingestion is %s', async (_label, lagHours) => {
            health.runsSummary.mockResolvedValue({ lagHours });

            const result = await useCase.execute(NOW);

            expect(result.skipped).toBe('warehouse_stale');
            expect(
                kodyRulesService.findOrganizationIdsWithRules,
            ).not.toHaveBeenCalled();
        });

        it('does nothing when the health check itself throws', async () => {
            health.runsSummary.mockRejectedValue(new Error('no table'));

            const result = await useCase.execute(NOW);

            expect(result.skipped).toBe('warehouse_unavailable');
        });

        it('keeps going when one organization fails', async () => {
            kodyRulesService.findOrganizationIdsWithRules.mockResolvedValue([
                'org-broken',
                ORG,
            ]);
            kodyRulesService.findByOrganizationId.mockImplementation(
                async (id) => {
                    if (id === 'org-broken') throw new Error('mongo down');
                    return {
                        uuid: 'doc-1',
                        rules: [rule('r1')],
                    };
                },
            );
            reviewAnalytics.getKodyRulesUsage.mockResolvedValue([
                usageRow('r1', IGNORED),
            ]);

            const result = await useCase.execute(NOW);

            expect(result.organizations).toBe(2);
            expect(result.failedOrganizations).toBe(1);
            expect(result.paused).toBe(1);
        });
    });

    describe('per organization', () => {
        it('reads only the active teams of the organization', async () => {
            givenRules([rule('r1')]);

            await useCase.executeForOrganization(ORG, NOW);

            expect(teamService.find).toHaveBeenCalledWith(
                { organization: { uuid: ORG } },
                [STATUS.ACTIVE],
            );
        });

        it('skips an organization outside the Cockpit tier', async () => {
            licenseService.validateOrganizationLicense.mockResolvedValue({
                valid: true,
                subscriptionStatus: 'self-hosted',
            });

            const result = await useCase.executeForOrganization(ORG, NOW);

            expect(result.skipped).toBe('tier');
            expect(
                kodyRulesService.findByOrganizationId,
            ).not.toHaveBeenCalled();
        });

        it('skips without reading usage when the setting is off everywhere', async () => {
            codeReviewConfig = { configs: {} };
            givenRules([rule('r1')]);

            const result = await useCase.executeForOrganization(ORG, NOW);

            expect(result.skipped).toBe('setting_off');
            expect(reviewAnalytics.getKodyRulesUsage).not.toHaveBeenCalled();
        });

        it('skips an organization whose rules live in a config repository', async () => {
            centralizedConfig = {
                enabled: true,
                repository: { id: 'cfg', name: 'acme/config' },
            };
            givenRules([rule('r1')]);

            const result = await useCase.executeForOrganization(ORG, NOW);

            expect(result.skipped).toBe('centralized_config');
            expect(kodyRulesService.createOrUpdate).not.toHaveBeenCalled();
        });

        it('pauses ignored and noisy rules with the numbers behind it, and leaves healthy ones', async () => {
            givenRules([
                rule('ignored-1'),
                rule('noisy-1', { repositoryId: 'global' }),
                rule('healthy-1'),
                rule('paused-1', { status: KodyRulesStatus.PAUSED }),
            ]);
            reviewAnalytics.getKodyRulesUsage.mockResolvedValue([
                usageRow('ignored-1', IGNORED),
                usageRow('noisy-1', NOISY),
                usageRow('healthy-1'),
                usageRow('paused-1', IGNORED),
            ]);

            const result = await useCase.executeForOrganization(ORG, NOW);

            expect(reviewAnalytics.getKodyRulesUsage).toHaveBeenCalledWith(
                {
                    organizationId: ORG,
                    startDate: THIRTY_DAYS_AGO,
                    endDate: NOW.toISOString(),
                },
                { suggestionsCreatedSince: undefined },
            );
            expect(result.paused).toBe(2);
            expect(kodyRulesService.createOrUpdate).toHaveBeenCalledTimes(2);
            expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
                { organizationId: ORG, teamId: 'team-1' },
                {
                    uuid: 'ignored-1',
                    status: KodyRulesStatus.PAUSED,
                    autoPause: {
                        state: 'ignored',
                        pausedAt: NOW,
                        windowStart: new Date(THIRTY_DAYS_AGO),
                        windowEnd: NOW,
                        triggers: 14,
                        implemented: 2,
                        rate: 0.14,
                        thumbsUp: 0,
                        thumbsDown: 0,
                        digestedAt: null,
                    },
                },
                { userId: 'kody-system', userEmail: 'kody@kodus.io' },
            );
            expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    uuid: 'noisy-1',
                    autoPause: expect.objectContaining({ state: 'noisy' }),
                }),
                expect.anything(),
            );
        });

        it('tells admins once per run, listing every paused rule', async () => {
            givenRules([rule('ignored-1'), rule('noisy-1')]);
            reviewAnalytics.getKodyRulesUsage.mockResolvedValue([
                usageRow('ignored-1', IGNORED),
                usageRow('noisy-1', NOISY),
            ]);

            await useCase.executeForOrganization(ORG, NOW);

            expect(notificationService.emit).toHaveBeenCalledTimes(1);
            expect(notificationService.emit).toHaveBeenCalledWith({
                event: NotificationEvent.KODY_RULES_AUTO_PAUSED,
                organizationId: ORG,
                payload: {
                    rules: [
                        expect.objectContaining({
                            ruleId: 'ignored-1',
                            title: 'Rule ignored-1',
                            repositoryId: 'repo-1',
                            repositoryName: 'acme/api',
                            state: 'ignored',
                            triggers: 14,
                            implemented: 2,
                            windowDays: 30,
                            sinceResume: false,
                            pausedAt: NOW.toISOString(),
                        }),
                        expect.objectContaining({
                            ruleId: 'noisy-1',
                            state: 'noisy',
                            thumbsDown: 5,
                        }),
                    ],
                },
            });
        });

        it('sends nothing when no rule is paused', async () => {
            givenRules([rule('healthy-1')]);
            reviewAnalytics.getKodyRulesUsage.mockResolvedValue([
                usageRow('healthy-1'),
            ]);

            const result = await useCase.executeForOrganization(ORG, NOW);

            expect(result.paused).toBe(0);
            expect(notificationService.emit).not.toHaveBeenCalled();
        });

        it('judges a resumed rule only on what it flagged after the resume', async () => {
            const resumedAt = new Date('2026-10-15T12:00:00.000Z');
            givenRules([rule('fresh-1'), rule('resumed-1', { resumedAt })]);
            reviewAnalytics.getKodyRulesUsage.mockImplementation(
                async (_q, opts) =>
                    opts?.suggestionsCreatedSince
                        ? [
                              usageRow('resumed-1', {
                                  triggers: 2,
                                  implemented: 0,
                                  rate: 0,
                              }),
                          ]
                        : [usageRow('fresh-1'), usageRow('resumed-1', IGNORED)],
            );

            const result = await useCase.executeForOrganization(ORG, NOW);

            expect(reviewAnalytics.getKodyRulesUsage).toHaveBeenCalledWith(
                {
                    organizationId: ORG,
                    startDate: resumedAt.toISOString(),
                    endDate: NOW.toISOString(),
                },
                { suggestionsCreatedSince: resumedAt.toISOString() },
            );
            // Too few triggers since the resume to judge it again.
            expect(result.paused).toBe(0);
        });

        it('a failed pause does not stop the others and is not announced', async () => {
            givenRules([rule('a'), rule('b')]);
            reviewAnalytics.getKodyRulesUsage.mockResolvedValue([
                usageRow('a', IGNORED),
                usageRow('b', IGNORED),
            ]);
            kodyRulesService.createOrUpdate.mockImplementation(
                async (_o, r) => {
                    if (r.uuid === 'a') throw new Error('write failed');
                    return r;
                },
            );

            const result = await useCase.executeForOrganization(ORG, NOW);

            expect(result.paused).toBe(1);
            expect(result.failed).toBe(1);
            const { payload } = notificationService.emit.mock.calls[0][0];
            expect(
                payload.rules.map((r: { ruleId: string }) => r.ruleId),
            ).toEqual(['b']);
        });

        it('a failed notification does not undo or fail the run', async () => {
            givenRules([rule('a')]);
            reviewAnalytics.getKodyRulesUsage.mockResolvedValue([
                usageRow('a', IGNORED),
            ]);
            notificationService.emit.mockRejectedValue(
                new Error('outbox down'),
            );

            const result = await useCase.executeForOrganization(ORG, NOW);

            expect(result.paused).toBe(1);
        });

        it('pauses a repository rule under the team that configures it', async () => {
            teamService.find.mockResolvedValue([
                { uuid: 'team-1' },
                { uuid: 'team-2' },
            ]);
            parametersService.findByKey.mockImplementation(async (key, ctx) => {
                if (key !== ParametersKey.CODE_REVIEW_CONFIG) return null;
                return {
                    configValue:
                        ctx.teamId === 'team-2'
                            ? {
                                  configs: { kodyRulesAutoPauseEnabled: true },
                                  repositories: [{ id: 'repo-2', configs: {} }],
                              }
                            : { configs: {} },
                };
            });
            givenRules([rule('r', { repositoryId: 'repo-2' })]);
            reviewAnalytics.getKodyRulesUsage.mockResolvedValue([
                usageRow('r', IGNORED),
            ]);

            await useCase.executeForOrganization(ORG, NOW);

            expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
                { organizationId: ORG, teamId: 'team-2' },
                expect.anything(),
                expect.anything(),
            );
        });
    });
});
