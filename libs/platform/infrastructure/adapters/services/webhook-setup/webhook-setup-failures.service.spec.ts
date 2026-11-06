import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';

import { WebhookSetupFailuresService } from './webhook-setup-failures.service';

const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };

describe('WebhookSetupFailuresService', () => {
    let stored: Record<string, unknown>;
    let integrationConfigService: {
        findIntegrationConfigFormatted: jest.Mock;
        createOrUpdateConfig: jest.Mock;
    };
    let service: WebhookSetupFailuresService;

    const selection = (...ids: string[]) =>
        ids.map((id) => ({ id, name: `repo-${id}` }));

    beforeEach(() => {
        stored = {
            [IntegrationConfigKey.REPOSITORIES]: selection('1', '2', '3'),
        };
        integrationConfigService = {
            findIntegrationConfigFormatted: jest.fn(
                async (key: string) => stored[key] ?? null,
            ),
            createOrUpdateConfig: jest.fn(async (key: string, value) => {
                stored[key] = value;
                return { configValue: value };
            }),
        };
        service = new WebhookSetupFailuresService(
            integrationConfigService as any,
        );
    });

    const record = () =>
        stored[IntegrationConfigKey.WEBHOOK_CREATION_FAILURES] as {
            failures: Record<string, { reason: string; at: string; kind?: string }>;
        };

    it('adds new failures and keeps the ones of repositories this run did not touch', async () => {
        stored[IntegrationConfigKey.WEBHOOK_CREATION_FAILURES] = {
            failures: { '3': { reason: 'old', at: '2026-01-01T00:00:00.000Z' } },
        };

        await service.recordOutcome({
            organizationAndTeamData: orgTeam,
            integrationId: 'int-1',
            startedAt: '2026-02-01T00:00:00.000Z',
            result: {
                configured: ['1'],
                failed: { '2': { reason: 'HTTP 403', kind: 'permission' } },
                notAttempted: [],
            },
        });

        expect(record().failures).toEqual({
            '2': {
                reason: 'HTTP 403',
                kind: 'permission',
                at: '2026-02-01T00:00:00.000Z',
            },
            '3': { reason: 'old', at: '2026-01-01T00:00:00.000Z' },
        });
        expect(integrationConfigService.createOrUpdateConfig).toHaveBeenCalledWith(
            IntegrationConfigKey.WEBHOOK_CREATION_FAILURES,
            expect.anything(),
            'int-1',
            orgTeam,
        );
    });

    it('clears the failure of a repository that now has its hook', async () => {
        stored[IntegrationConfigKey.WEBHOOK_CREATION_FAILURES] = {
            failures: { '1': { reason: 'old', at: '2026-01-01T00:00:00.000Z' } },
        };

        await service.recordOutcome({
            organizationAndTeamData: orgTeam,
            integrationId: 'int-1',
            startedAt: '2026-02-01T00:00:00.000Z',
            result: { configured: ['1'], failed: {}, notAttempted: [] },
        });

        expect(record().failures).toEqual({});
    });

    it('does not let an older run overwrite what a newer run observed', async () => {
        stored[IntegrationConfigKey.WEBHOOK_CREATION_FAILURES] = {
            failures: {
                '1': { reason: 'newer', at: '2026-03-01T00:00:00.000Z' },
            },
        };

        await service.recordOutcome({
            organizationAndTeamData: orgTeam,
            integrationId: 'int-1',
            startedAt: '2026-02-01T00:00:00.000Z',
            result: { configured: ['1'], failed: {}, notAttempted: [] },
        });

        expect(record().failures['1'].reason).toBe('newer');
    });

    it('marks repositories left untouched by a rate limit as pending, without replacing a known reason', async () => {
        stored[IntegrationConfigKey.WEBHOOK_CREATION_FAILURES] = {
            failures: { '3': { reason: 'HTTP 403', at: '2026-01-01T00:00:00.000Z', kind: 'permission' } },
        };

        await service.recordOutcome({
            organizationAndTeamData: orgTeam,
            integrationId: 'int-1',
            startedAt: '2026-02-01T00:00:00.000Z',
            result: {
                configured: [],
                failed: { '1': { reason: 'HTTP 429', kind: 'rate_limited' } },
                notAttempted: ['2', '3'],
                rateLimited: {},
            },
        });

        expect(record().failures['2'].kind).toBe('rate_limited');
        expect(record().failures['3'].kind).toBe('permission');
    });

    it('drops entries of repositories that are no longer in the selection', async () => {
        stored[IntegrationConfigKey.WEBHOOK_CREATION_FAILURES] = {
            failures: { '9': { reason: 'gone', at: '2026-01-01T00:00:00.000Z' } },
        };

        await service.recordOutcome({
            organizationAndTeamData: orgTeam,
            integrationId: 'int-1',
            startedAt: '2026-02-01T00:00:00.000Z',
            result: { configured: [], failed: {}, notAttempted: [] },
        });

        expect(record().failures).toEqual({});
    });

    it('lists the repositories with pending webhook work', async () => {
        stored[IntegrationConfigKey.WEBHOOK_CREATION_FAILURES] = {
            failures: {
                '2': { reason: 'x', at: '2026-01-01T00:00:00.000Z' },
                '3': { reason: 'y', at: '2026-01-01T00:00:00.000Z' },
            },
        };

        await expect(service.pendingRepositoryIds(orgTeam)).resolves.toEqual([
            '2',
            '3',
        ]);
    });

    it('does not throw when the record cannot be written', async () => {
        integrationConfigService.createOrUpdateConfig.mockRejectedValue(
            new Error('db down'),
        );

        await expect(
            service.recordOutcome({
                organizationAndTeamData: orgTeam,
                integrationId: 'int-1',
                startedAt: '2026-02-01T00:00:00.000Z',
                result: { configured: [], failed: {}, notAttempted: [] },
            }),
        ).resolves.toBeUndefined();
    });
});
