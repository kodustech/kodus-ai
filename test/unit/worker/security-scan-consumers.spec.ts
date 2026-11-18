import {
    RabbitMQModule,
    RABBIT_CONFIG_TOKEN,
    RABBIT_HANDLER,
} from '@golevelup/nestjs-rabbitmq';
import { RabbitMQWrapperModule } from '@libs/core/infrastructure/queue/rabbitmq.module';
import { SecurityScanJobConsumer } from '@libs/core/workflow/infrastructure/security-scan-job.consumer';
import { CodeReviewFeedbackConsumer } from '@libs/core/infrastructure/queue/messageBroker/consumers/codeReviewFeedback.consumer';
import { NotificationConsumer } from '@libs/notifications/infrastructure/consumers/notification.consumer';
import { ASTEventHandler } from '@libs/core/workflow/infrastructure/ast-event-handler.service';
import { HeavyStageEventHandler } from '@libs/core/workflow/engine/heavy-stage-event.handler';

describe('security-scan queue isolation', () => {
    it('registers only its own subscriber even when review modules are imported', async () => {
        const wrapper = RabbitMQWrapperModule.register({
            enableConsumers: true,
            securityScanOnly: true,
        });
        const dynamic = (wrapper.imports as any[]).find(
            (m) => m.module === RabbitMQModule,
        );
        const options = await dynamic.providers
            .find((p: any) => p.provide === RABBIT_CONFIG_TOKEN)
            .useFactory({ get: () => undefined });
        const methods = [
            SecurityScanJobConsumer,
            CodeReviewFeedbackConsumer,
            NotificationConsumer,
            ASTEventHandler,
            HeavyStageEventHandler,
        ].flatMap((type) =>
            Object.getOwnPropertyNames(type.prototype).flatMap((methodName) => {
                const handler = type.prototype[methodName];
                const meta =
                    typeof handler === 'function' &&
                    Reflect.getMetadata(RABBIT_HANDLER, handler);
                return meta
                    ? [
                          {
                              meta,
                              discoveredMethod: {
                                  handler,
                                  methodName,
                                  parentClass: {
                                      name: type.name,
                                      instance: Object.create(type.prototype),
                                  },
                              },
                          },
                      ]
                    : [];
            }),
        );
        const connection = {
            configuration: { ...options, registerHandlers: true },
            createSubscriber: jest.fn(),
        };
        (RabbitMQModule as any).bootstrapped = false;
        const module = new (RabbitMQModule as any)(
            {
                providerMethodsWithMetaAtKey: async () => methods,
                controllerMethodsWithMetaAtKey: async () => [],
            },
            { create: () => jest.fn() },
            {},
            { getConnections: () => [connection] },
            {},
        );
        try {
            await module.onApplicationBootstrap();
            expect(methods.length).toBeGreaterThanOrEqual(5);
            expect(connection.createSubscriber).toHaveBeenCalledTimes(1);
            expect(connection.createSubscriber.mock.calls[0][1].queue).toBe(
                'workflow.jobs.security_scan.queue',
            );
        } finally {
            (RabbitMQModule as any).bootstrapped = false;
        }
    });
});
