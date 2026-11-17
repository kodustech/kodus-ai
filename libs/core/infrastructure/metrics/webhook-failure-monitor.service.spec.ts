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
                    new Error('canceling statement due to statement timeout'),
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
            expect.stringContaining('statement timeout'),
        );
    });
});
