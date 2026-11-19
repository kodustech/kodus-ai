import { WebhookFailureMonitorService } from './webhook-failure-monitor.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('WebhookFailureMonitorService', () => {
    it('reports a failed heartbeat when it cannot read the webhook jobs, instead of going silent', async () => {
        const queryBuilder: any = {
            select: () => queryBuilder,
            addSelect: () => queryBuilder,
            where: () => queryBuilder,
            andWhere: () => queryBuilder,
            getRawOne: () =>
                Promise.reject(
                    Object.assign(
                        new Error(
                            'connect failed for postgres://kodus:not-a-real-password@db:5432',
                        ),
                        {
                            name: 'QueryFailedError',
                            driverError: { code: '57014' },
                        },
                    ),
                ),
        };
        const incidentManager = {
            pingHeartbeat: jest.fn(async () => undefined),
            failHeartbeat: jest.fn(async () => undefined),
        };
        const service = new WebhookFailureMonitorService(
            { createQueryBuilder: () => queryBuilder } as any,
            incidentManager as any,
            { get: (_key: string, fallback: unknown) => fallback } as any,
            {
                acquire: async () => ({ release: async () => undefined }),
            } as any,
        );

        await service.checkWebhookFailureRate();

        expect(incidentManager.pingHeartbeat).not.toHaveBeenCalled();
        expect(incidentManager.failHeartbeat).toHaveBeenCalledWith(
            'API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL',
            'Webhook failure monitor could not run: QueryFailedError (57014)',
        );
    });

    it('says so when BetterStack cannot take the failed heartbeat either', async () => {
        const queryBuilder: any = {
            select: () => queryBuilder,
            addSelect: () => queryBuilder,
            where: () => queryBuilder,
            andWhere: () => queryBuilder,
            getRawOne: () => Promise.reject(new Error('statement timeout')),
        };
        const service = new WebhookFailureMonitorService(
            { createQueryBuilder: () => queryBuilder } as any,
            {
                pingHeartbeat: jest.fn(async () => undefined),
                failHeartbeat: jest.fn(async () => {
                    throw new Error('betterstack unreachable');
                }),
            } as any,
            { get: (_key: string, fallback: unknown) => fallback } as any,
            {
                acquire: async () => ({ release: async () => undefined }),
            } as any,
        );
        const warn = (service as any).logger.warn as jest.Mock;

        await expect(
            service.checkWebhookFailureRate(),
        ).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('BetterStack'),
            }),
        );
    });
});
