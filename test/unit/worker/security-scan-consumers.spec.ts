import {
    RabbitMQModule,
    RABBIT_CONFIG_TOKEN,
    RABBIT_HANDLER,
} from '@golevelup/nestjs-rabbitmq';
import {
    RabbitMQWrapperModule,
    type RabbitMQWrapperOptions,
} from '@libs/core/infrastructure/queue/rabbitmq.module';
import { SecurityScanJobConsumer } from '@libs/core/workflow/infrastructure/security-scan-job.consumer';
import { CodeReviewFeedbackConsumer } from '@libs/core/infrastructure/queue/messageBroker/consumers/codeReviewFeedback.consumer';
import { NotificationConsumer } from '@libs/notifications/infrastructure/consumers/notification.consumer';
import { ASTEventHandler } from '@libs/core/workflow/infrastructure/ast-event-handler.service';
import { HeavyStageEventHandler } from '@libs/core/workflow/engine/heavy-stage-event.handler';

async function bootstrapHandlers(options: RabbitMQWrapperOptions) {
    const wrapper = RabbitMQWrapperModule.register(options);
    const dynamic = (wrapper.imports as any[]).find(
        (m) => m.module === RabbitMQModule,
    );
    const config = await dynamic.providers
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
    // golevelup's connection defaults (registerHandlers: true) under the
    // module's options, as AmqpConnection merges them.
    const connection = {
        configuration: { registerHandlers: true, ...config },
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
    } finally {
        (RabbitMQModule as any).bootstrapped = false;
    }
    expect(methods.length).toBeGreaterThanOrEqual(5);
    return connection.createSubscriber;
}

describe('security-scan queue isolation', () => {
    it('registers only its own subscriber even when review modules are imported', async () => {
        const createSubscriber = await bootstrapHandlers({
            enableConsumers: true,
            securityScanOnly: true,
        });

        expect(createSubscriber).toHaveBeenCalledTimes(1);
        expect(createSubscriber.mock.calls[0][1].queue).toBe(
            'workflow.jobs.security_scan.queue',
        );
    });

    it('registers no subscriber in a slice child', async () => {
        const createSubscriber = await bootstrapHandlers({
            enableConsumers: false,
            securityScanOnly: true,
        });

        expect(createSubscriber).not.toHaveBeenCalled();
    });
});
