import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

import { SpendLimitAlertService } from './spend-limit-alert.service';

const ORG = { organizationId: 'org-1' } as any;
const NOW = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));

const loaded = (
    config: Record<string, unknown>,
    evaluation: Record<string, unknown>,
) => ({
    config: { enabled: true, monthlyLimitUsd: 1000, ...config },
    evaluation: {
        organizationId: 'org-1',
        periodKey: '2026-06',
        spentUsd: 0,
        crossedThresholds: [],
        isOverLimit: false,
        byModel: [],
        ...evaluation,
    },
});

describe('SpendLimitAlertService', () => {
    let service: SpendLimitAlertService;
    let configService: { loadAndEvaluate: jest.Mock; saveConfig: jest.Mock };
    let notifications: { emit: jest.Mock };

    beforeEach(() => {
        configService = {
            loadAndEvaluate: jest.fn().mockResolvedValue(null),
            saveConfig: jest.fn(),
        };
        notifications = { emit: jest.fn() };
        service = new SpendLimitAlertService(
            configService as any,
            notifications as any,
        );
    });

    it('does nothing when there is no enabled limit', async () => {
        configService.loadAndEvaluate.mockResolvedValue(null);
        await service.runForOrganization(ORG, NOW);
        expect(notifications.emit).not.toHaveBeenCalled();
        expect(configService.saveConfig).not.toHaveBeenCalled();
    });

    it('emits one threshold alert per newly crossed threshold and persists state', async () => {
        configService.loadAndEvaluate.mockResolvedValue(
            loaded(
                {},
                { spentUsd: 760, crossedThresholds: [50, 75], isOverLimit: false },
            ),
        );

        await service.runForOrganization(ORG, NOW);

        expect(notifications.emit).toHaveBeenCalledTimes(2);
        const events = notifications.emit.mock.calls.map((c) => c[0].event);
        expect(events).toEqual([
            NotificationEvent.SPEND_LIMIT_THRESHOLD_REACHED,
            NotificationEvent.SPEND_LIMIT_THRESHOLD_REACHED,
        ]);
        const first = notifications.emit.mock.calls[0][0];
        expect(first.organizationId).toBe('org-1');
        expect(first.payload).toEqual({
            percentage: 50,
            monthlyLimitUsd: 1000,
            spentUsd: 760,
            periodKey: '2026-06',
        });
        // No recipients: the audience is resolved from the event's
        // defaultRoles + notification config at dispatch time.
        expect(first.recipients).toBeUndefined();

        const saved = configService.saveConfig.mock.calls[0][1];
        expect(saved.thresholdsSent['2026-06']).toEqual([50, 75]);
    });

    it('does not re-emit thresholds already sent this period', async () => {
        configService.loadAndEvaluate.mockResolvedValue(
            loaded(
                { thresholdsSent: { '2026-06': [50, 75] } },
                { spentUsd: 760, crossedThresholds: [50, 75], isOverLimit: false },
            ),
        );

        await service.runForOrganization(ORG, NOW);

        expect(notifications.emit).not.toHaveBeenCalled();
        expect(configService.saveConfig).not.toHaveBeenCalled();
    });

    it('sends the over-limit final notice once 100% was already alerted', async () => {
        configService.loadAndEvaluate.mockResolvedValue(
            loaded(
                { thresholdsSent: { '2026-06': [50, 75, 90, 100] } },
                {
                    spentUsd: 1200,
                    crossedThresholds: [50, 75, 90, 100],
                    isOverLimit: true,
                },
            ),
        );

        await service.runForOrganization(ORG, NOW);

        expect(notifications.emit).toHaveBeenCalledTimes(1);
        const call = notifications.emit.mock.calls[0][0];
        expect(call.event).toBe(NotificationEvent.SPEND_LIMIT_EXCEEDED_FINAL);
        expect(call.payload).toEqual({
            monthlyLimitUsd: 1000,
            spentUsd: 1200,
            periodKey: '2026-06',
        });
        const saved = configService.saveConfig.mock.calls[0][1];
        expect(saved.finalNoticeSent['2026-06']).toBe(true);
    });

    it('preserves alert state for other periods when persisting', async () => {
        configService.loadAndEvaluate.mockResolvedValue(
            loaded(
                { thresholdsSent: { '2026-05': [50, 75, 90, 100] } },
                { spentUsd: 510, crossedThresholds: [50], isOverLimit: false },
            ),
        );

        await service.runForOrganization(ORG, NOW);

        const saved = configService.saveConfig.mock.calls[0][1];
        expect(saved.thresholdsSent).toEqual({
            '2026-05': [50, 75, 90, 100],
            '2026-06': [50],
        });
    });
});
